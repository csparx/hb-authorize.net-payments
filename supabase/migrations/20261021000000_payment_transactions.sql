-- Log of every payment attempt that reaches Authorize.net (approved, declined, or error).
-- NEVER store full card number, expiration, CVV, or the Accept.js nonce.

create table if not exists public.payment_transactions (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),

  account                 text not null check (account in ('hb', 'pw', 'expo', 'pwshow')),
  environment             text not null check (environment in ('sandbox', 'live')),
  status                  text not null check (status in ('approved', 'declined', 'error')),

  authnet_transaction_id  text,
  authnet_response_code   text,
  authnet_message         text,

  invoice_amount          numeric(10,2) not null,
  convenience_fee         numeric(10,2) not null,
  total_charged           numeric(10,2) not null,

  invoice_number          text,
  account_number          text,
  charge_description      text,

  first_name              text,
  last_name               text,
  company                 text,
  email                   text,
  phone                   text,
  city                    text,
  state                   text,
  zip                     text,

  signature_name          text,

  card_type               text,
  card_last4              text,

  receipt_email_sent      boolean not null default false,
  internal_email_sent     boolean not null default false,

  ip_address              text
);

-- Rate limiting looks up recent attempts by IP.
create index if not exists payment_transactions_ip_created_idx
  on public.payment_transactions (ip_address, created_at desc);

-- RLS on with NO policies: anon/authenticated get nothing. Only the service role
-- (used by the Vercel function, which bypasses RLS) can read or write.
alter table public.payment_transactions enable row level security;
revoke all on public.payment_transactions from anon, authenticated;
