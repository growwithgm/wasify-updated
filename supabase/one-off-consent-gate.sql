-- ============================================================================
-- ONE-OFF: consent-gate cutover.  Run ONCE, at deploy time, AFTER schema.sql.
-- This file is deliberately NOT part of schema.sql.
-- ============================================================================
-- The recovery gate (skipped_no_consent) flips non-consented rows the next
-- time each one is swept, one 15-minute tick at a time. This does the same
-- thing in one statement so the dashboard is clean immediately.
--
-- Safe to re-run: it only ever matches rows the sweep gate would flip
-- anyway — an active row whose contact has no explicit opt-in, or whose
-- number sits on the suppression list. Rows for genuinely opted-in
-- contacts are untouched.

update public.checkout_recoveries r
set status = 'skipped_no_consent',
    last_error = 'No WhatsApp marketing opt-in, or the number is on the suppression list'
where r.status = 'active'
  and (
    not exists (
      select 1
      from public.contacts c
      where c.id = r.contact_id
        and c.opt_in_status = 'opted_in'
    )
    or exists (
      select 1
      from public.suppression_list s
      where s.user_id = r.user_id
        and s.phone = r.phone
    )
  );
