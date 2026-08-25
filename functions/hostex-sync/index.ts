// RS Properties — Supabase Edge Function
// Fetches reservations from Hostex API for a given property + month
// Cross-month stays (check-in prev month, checkout this month) are included
// with income/roomrate prorated by nights falling within the target month.
// Deploy: supabase functions deploy hostex-sync

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const HOSTEX_BASE = "https://api.hostex.io/v3";

const CHANNEL_MAP: Record<string, string> = {
  "airbnb":         "Airbnb",
  "booking.com":    "Booking.com",
  "vrbo":           "Vrbo",
  "expedia":        "Expedia",
  "agoda":          "Agoda",
  "hostex_direct":  "Direct",
  "trip.com":       "Trip.com",
  "booking_site":   "Direct",
};

function normChannel(raw: string): string {
  return CHANNEL_MAP[raw?.toLowerCase()] ?? raw ?? "Other";
}

function isoDate(s: string): string {
  return (s || "").slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// How many nights of [checkin, checkout) fall within the given month.
// Mirrors the _nightsInMonth() logic used in the RS Builder frontend.
function nightsInMonth(checkin: string, checkout: string, year: number, mon: number): number {
  const mStart = new Date(year, mon - 1, 1);
  const mEnd   = new Date(year, mon,     1); // exclusive — first day of next month
  const ci     = new Date(checkin);
  const co     = new Date(checkout);
  const start  = ci < mStart ? mStart : ci;
  const end    = co > mEnd   ? mEnd   : co;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

// Paginate through all Hostex reservations for a check-in date range.
async function fetchByCheckin(
  propertyId: string | number,
  startDate: string,
  endDate: string,
  apiKey: string,
): Promise<any[]> {
  let all: any[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      property_id:         String(propertyId),
      start_check_in_date: startDate,
      end_check_in_date:   endDate,
      status:              "accepted",
      limit:               String(limit),
      offset:              String(offset),
    });

    const res = await fetch(`${HOSTEX_BASE}/reservations?${params}`, {
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Hostex API error ${res.status}: ${err}`);
    }

    const data  = await res.json();
    const batch: any[] = data?.data?.reservations ?? data?.reservations ?? [];
    all = all.concat(batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return all;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const HOSTEX_API_KEY = Deno.env.get("HOSTEX_API_KEY");
  if (!HOSTEX_API_KEY) {
    return new Response(
      JSON.stringify({ error: "HOSTEX_API_KEY secret not configured" }),
      { headers: { ...CORS, "Content-Type": "application/json" }, status: 500 }
    );
  }

  try {
    const { hostexPropertyId, month } = await req.json();

    if (!hostexPropertyId || !month) {
      return new Response(
        JSON.stringify({ error: "hostexPropertyId and month are required" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const [yearStr, monthStr] = month.split("-");
    const year = parseInt(yearStr);
    const mon  = parseInt(monthStr);
    const startDate = `${year}-${String(mon).padStart(2, "0")}-01`;
    const endDate   = `${year}-${String(mon).padStart(2, "0")}-${String(lastDayOfMonth(year, mon)).padStart(2, "0")}`;

    // ── 1. Fetch reservations with check-in in target month ───────────────────
    const currentRsvs = await fetchByCheckin(hostexPropertyId, startDate, endDate, HOSTEX_API_KEY);

    // ── 2. Fetch reservations with check-in in the PREVIOUS month ─────────────
    //    Keep only those whose checkout falls within (or after) the target month
    //    — these are cross-month stays that belong partly to this month.
    const prevYear    = mon === 1 ? year - 1 : year;
    const prevMon     = mon === 1 ? 12 : mon - 1;
    const prevStart   = `${prevYear}-${String(prevMon).padStart(2, "0")}-01`;
    const prevEnd     = `${prevYear}-${String(prevMon).padStart(2, "0")}-${String(lastDayOfMonth(prevYear, prevMon)).padStart(2, "0")}`;

    const prevRsvs    = await fetchByCheckin(hostexPropertyId, prevStart, prevEnd, HOSTEX_API_KEY);
    // Strictly ">": a checkout landing exactly on day 1 of this month does
    // NOT get a leg here - by policy (see index.html _hxCleaningMonth) its
    // cleaning fee bills to the PRECEDING month instead, and that month's own
    // sync already carries this reservation via the forward-spillover case
    // below. Pulling it in here too would create a duplicate empty leg.
    const crossMonth  = prevRsvs.filter((r: any) => isoDate(r.check_out_date) > startDate);

    // ── 3. Map all reservations → RS Builder format ───────────────────────────
    const mapReservation = (r: any, isCross: boolean) => {
      const checkin  = isoDate(r.check_in_date);
      const checkout = isoDate(r.check_out_date);

      const nights = (checkin && checkout)
        ? Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86_400_000) || 1
        : 0;

      const income = Number(r.payment?.total_amount ?? 0);

      let roomrate = 0;
      const details: any[] = r.rates?.details ?? [];
      const accDetail = details.find((d: any) => d.type === "ACCOMMODATION");
      roomrate = accDetail
        ? Number(accDetail.amount ?? 0)
        : Number(r.rates?.rate?.amount ?? 0);

      const channel = r.custom_channel?.name ?? normChannel(r.channel_type ?? "");

      // For cross-month reservations prorate income, roomrate, AND nights
      // by the fraction that falls within the target month.
      // Setting nights = nim fixes both the Nights column display and
      // the city-tax calculation (getCityTax uses r.nights × guests × taxRate).
      let nightsOut = nights;
      let ratio     = 1;
      if (isCross && nights > 0) {
        const nim = nightsInMonth(checkin, checkout, year, mon);
        nightsOut = nim;
        ratio     = nim / nights;
      }

      return {
        source:      channel,
        guest:       r.guest_name ?? "",
        checkin,
        checkout,
        nights:      nightsOut,
        booked:      isoDate(r.booked_at ?? ""),
        guests:      Number(r.number_of_guests ?? 2),
        roomrate:    Math.round(roomrate * ratio * 100) / 100,
        income:      Math.round(income  * ratio * 100) / 100,
        cleaning:    0,   // applied from property defaultCleaning on the frontend
        extra:       {},
        extraIncome: {},
        // Stable Hostex identity, independent of guest-name/date parsing —
        // lets the frontend detect price changes and cancellations on
        // resync instead of only ever adding new rows.
        reservationCode: r.reservation_code ?? null,
      };
    };

    // A currentRsvs item can itself spill FORWARD into next month (checkin
    // this month, checkout next month) — mirrors the backward crossMonth
    // case above and needs the same proration, or the full stay's nights/
    // income get counted entirely in the check-in month.
    const mapped = [
      ...currentRsvs.map((r: any) => mapReservation(r, isoDate(r.check_out_date) > endDate)),
      ...crossMonth .map((r: any) => mapReservation(r, true)),
    ];

    return new Response(
      JSON.stringify({ ok: true, count: mapped.length, reservations: mapped }),
      { headers: { ...CORS, "Content-Type": "application/json" }, status: 200 }
    );

  } catch (err) {
    console.error("hostex-sync error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { headers: { ...CORS, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
