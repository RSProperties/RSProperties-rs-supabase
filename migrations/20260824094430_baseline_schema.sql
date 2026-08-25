-- Baseline migration: captures the schema of the RS Properties Supabase
-- project (jswqdjevbncfqinntajg) as it existed on 2026-08-24, reconstructed
-- via information_schema/pg_catalog introspection (pg_dump was unavailable
-- on this machine — no Docker installed). This is the FIRST tracked
-- migration; the project had no local migration history before this.
-- Applied to the remote DB already — this file documents what is live,
-- it does not need to be (re-)applied there. Use `supabase migration repair
-- --status applied <version>` after adding this file if the CLI ever
-- complains about the remote migration history not matching.

CREATE TABLE IF NOT EXISTS public."owner_comment_replies" (
  "id" text NOT NULL,
  "comment_id" text NOT NULL,
  "author" text NOT NULL,
  "message" text NOT NULL,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."owner_comments" (
  "id" text NOT NULL,
  "report_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "owner_name" text NOT NULL,
  "comment" text NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "read_by_team" boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public."owner_reset_tokens" (
  "token" text NOT NULL,
  "owner_id" text NOT NULL,
  "username" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used" boolean DEFAULT false,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."owner_users" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "username" text NOT NULL,
  "password_hash" text NOT NULL DEFAULT ''::text,
  "email" text DEFAULT ''::text,
  "property_ids" jsonb DEFAULT '[]'::jsonb,
  "property_names" jsonb DEFAULT '[]'::jsonb,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."property_share_tokens" (
  "token" text NOT NULL,
  "property_id" text NOT NULL,
  "property_name" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."reports" (
  "id" text NOT NULL,
  "month" text,
  "prop_id" text,
  "prop_name" text,
  "data" jsonb NOT NULL,
  "saved_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."team_users" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "password" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member'::text,
  "permissions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_login" timestamptz,
  "invite_token" text,
  "name_locked" boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public."warehouse_items" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "category" text DEFAULT ''::text,
  "unit" text DEFAULT 'ks'::text,
  "quantity" integer DEFAULT 0,
  "min_quantity" integer DEFAULT 0,
  "notes" text DEFAULT ''::text,
  "supplier" text DEFAULT ''::text,
  "unit_price" numeric DEFAULT 0,
  "location" text DEFAULT ''::text,
  "ean" text DEFAULT ''::text,
  "created_by" text DEFAULT ''::text,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "warehouse" text NOT NULL DEFAULT 'presov'::text
);

CREATE TABLE IF NOT EXISTS public."warehouse_log" (
  "id" text NOT NULL,
  "item_id" text,
  "item_name" text,
  "item_unit" text DEFAULT 'ks'::text,
  "action" text,
  "quantity" integer,
  "quantity_after" integer,
  "unit_price" numeric DEFAULT 0,
  "total_price" numeric DEFAULT 0,
  "supplier" text DEFAULT ''::text,
  "invoice_no" text DEFAULT ''::text,
  "user_name" text DEFAULT ''::text,
  "property_name" text DEFAULT ''::text,
  "note" text DEFAULT ''::text,
  "created_at" timestamptz DEFAULT now(),
  "warehouse" text DEFAULT 'presov'::text
);

CREATE TABLE IF NOT EXISTS public."workspace" (
  "key" text NOT NULL,
  "value" jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ── Constraints (primary keys, foreign keys, unique, checks) ──
ALTER TABLE public."owner_comment_replies" ADD CONSTRAINT "owner_comment_replies_pkey" PRIMARY KEY (id);
ALTER TABLE public."owner_comments" ADD CONSTRAINT "owner_comments_pkey" PRIMARY KEY (id);
ALTER TABLE public."owner_reset_tokens" ADD CONSTRAINT "owner_reset_tokens_pkey" PRIMARY KEY (token);
ALTER TABLE public."owner_users" ADD CONSTRAINT "owner_users_pkey" PRIMARY KEY (id);
ALTER TABLE public."property_share_tokens" ADD CONSTRAINT "property_share_tokens_pkey" PRIMARY KEY (token);
ALTER TABLE public."reports" ADD CONSTRAINT "reports_pkey" PRIMARY KEY (id);
ALTER TABLE public."team_users" ADD CONSTRAINT "team_users_pkey" PRIMARY KEY (id);
ALTER TABLE public."warehouse_items" ADD CONSTRAINT "warehouse_items_pkey" PRIMARY KEY (id);
ALTER TABLE public."warehouse_log" ADD CONSTRAINT "warehouse_log_pkey" PRIMARY KEY (id);
ALTER TABLE public."workspace" ADD CONSTRAINT "workspace_pkey" PRIMARY KEY (key);
ALTER TABLE public."owner_users" ADD CONSTRAINT "owner_users_username_key" UNIQUE (username);
ALTER TABLE public."team_users" ADD CONSTRAINT "team_users_email_key" UNIQUE (email);

-- ── Indexes ──

-- ── Row Level Security ──
ALTER TABLE public."owner_comment_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."owner_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."owner_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."owner_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."property_share_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."warehouse_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."warehouse_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."workspace" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all_replies" ON public."owner_comment_replies" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_comments" ON public."owner_comments" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon insert token" ON public."owner_reset_tokens" AS PERMISSIVE FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon select own token by exact match" ON public."owner_reset_tokens" AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon update token to mark used" ON public."owner_reset_tokens" AS PERMISSIVE FOR UPDATE TO anon USING (true);
CREATE POLICY "anon full access owner_users" ON public."owner_users" AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "team_owner_users" ON public."owner_users" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon insert share token" ON public."property_share_tokens" AS PERMISSIVE FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon select share token" ON public."property_share_tokens" AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "team_reports" ON public."reports" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON public."team_users" AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_team_users" ON public."team_users" AS PERMISSIVE FOR DELETE TO public USING (true);
CREATE POLICY "anon_read_team_users" ON public."team_users" AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "anon_update_team_users" ON public."team_users" AS PERMISSIVE FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "sklad_all" ON public."warehouse_items" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "log_all" ON public."warehouse_log" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "team_workspace" ON public."workspace" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
