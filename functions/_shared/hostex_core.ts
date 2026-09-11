// Shared Hostex reservation-fetch logic — extracted verbatim from
// hostex-sync/index.ts (2026-09-10) so hostex-daily-sync can pull every
// property in ONE function invocation instead of fanning out to 69
// hostex-sync calls (which trips Supabase's function-invocation rate
// limit). hostex-sync itself is left untouched.
//
// Business rule (memory rs-builder-no-hostex-fees): cleaning + city tax
// are NOT read from Hostex — `cleaning` is always 0 here; the frontend
// applies both from each property's own config.

export const HOSTEX_BASE = "https://api.hostex.io/v3";

const CHANNEL_MAP: Record<string, string> = {
  "airbnb": "Airbnb",
  "booking.com": "Booking.com",
  "vrbo": "Vrbo",
  "expedia": "Expedia",
  "agoda": "Agoda",
  "hostex_direct": "Direct",
  "trip.com": "Trip.com",
  "booking_site": "Direct",
};

export function normChannel(raw: string): string {
  return CHANNEL_MAP[raw?.toLowerCase()] ?? raw ?? "Other";
}
export function isoDate(s: string): string {
  return (s || "").slice(0, 10);
}
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
function nightsInMonth(checkin: string, checkout: string, year: number, mon: number): number {
  const mStart = new Date(year, mon - 1, 1);
  const mEnd = new Date(year, mon, 1);
  const ci = new Date(checkin);
  const co = new Date(checkout);
  const start = ci < mStart ? mStart : ci;
  const end = co > mEnd ? mEnd : co;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

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
      property_id: String(propertyId),
      start_check_in_date: startDate,
      end_check_in_date: endDate,
      status: "accepted",
      limit: String(limit),
      offset: String(offset),
    });
    const res = await fetch(`${HOSTEX_BASE}/reservations?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Hostex API error ${res.status}: ${err}`);
    }
    const data = await res.json();
    const batch: any[] = data?.data?.reservations ?? data?.reservations ?? [];
    all = all.concat(batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

// Returns RS Builder-format reservation rows for one property + month,
// including cross-month proration (backward and forward spillover).
export async function syncPropertyMonth(
  hostexPropertyId: string | number,
  month: string,
  apiKey: string,
): Promise<any[]> {
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr);
  const mon = parseInt(monthStr);
  const startDate = `${year}-${String(mon).padStart(2, "0")}-01`;
  const endDate = `${year}-${String(mon).padStart(2, "0")}-${String(lastDayOfMonth(year, mon)).padStart(2, "0")}`;

  const currentRsvs = await fetchByCheckin(hostexPropertyId, startDate, endDate, apiKey);

  const prevYear = mon === 1 ? year - 1 : year;
  const prevMon = mon === 1 ? 12 : mon - 1;
  const prevStart = `${prevYear}-${String(prevMon).padStart(2, "0")}-01`;
  const prevEnd = `${prevYear}-${String(prevMon).padStart(2, "0")}-${String(lastDayOfMonth(prevYear, prevMon)).padStart(2, "0")}`;
  const prevRsvs = await fetchByCheckin(hostexPropertyId, prevStart, prevEnd, apiKey);
  const crossMonth = prevRsvs.filter((r: any) => isoDate(r.check_out_date) > startDate);

  const mapReservation = (r: any, isCross: boolean) => {
    const checkin = isoDate(r.check_in_date);
    const checkout = isoDate(r.check_out_date);
    const nights = (checkin && checkout)
      ? Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86_400_000) || 1
      : 0;
    const income = Number(r.payment?.total_amount ?? 0);
    let roomrate = 0;
    const details: any[] = r.rates?.details ?? [];
    const accDetail = details.find((d: any) => d.type === "ACCOMMODATION");
    roomrate = accDetail ? Number(accDetail.amount ?? 0) : Number(r.rates?.rate?.amount ?? 0);
    const channel = r.custom_channel?.name ?? normChannel(r.channel_type ?? "");
    let nightsOut = nights;
    let ratio = 1;
    if (isCross && nights > 0) {
      const nim = nightsInMonth(checkin, checkout, year, mon);
      nightsOut = nim;
      ratio = nim / nights;
    }
    return {
      source: channel,
      guest: r.guest_name ?? "",
      checkin,
      checkout,
      nights: nightsOut,
      booked: isoDate(r.booked_at ?? ""),
      guests: Number(r.number_of_guests ?? 2),
      roomrate: Math.round(roomrate * ratio * 100) / 100,
      income: Math.round(income * ratio * 100) / 100,
      cleaning: 0,
      extra: {},
      extraIncome: {},
      reservationCode: r.reservation_code ?? null,
    };
  };

  return [
    ...currentRsvs.map((r: any) => mapReservation(r, isoDate(r.check_out_date) > endDate)),
    ...crossMonth.map((r: any) => mapReservation(r, true)),
  ];
}
