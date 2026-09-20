-- ONE-OFF — recovery gate opened (block-list instead of opt-in allow-list).
-- Run ONCE in the Supabase SQL editor, AFTER deploying the matching app
-- version. Re-running is safe.
--
-- The merchant's decision: the opt-in requirement governs the POPUP only.
-- Abandoned-checkout reminders go to every cart with a phone, blocked only
-- by an explicit opt-out or a suppression-list row.
--
-- This revives the rows the old allow-list gate parked. Flipping them all
-- to active is safe: the very next sweep re-checks every row — the truly
-- blocked ones (opted out / suppressed) get re-parked with a clear reason,
-- and carts older than the freshness window are parked as expired without
-- sending anything. Only fresh, unblocked carts resume their sequence.

update checkout_recoveries
set status = 'active', last_error = null
where status = 'skipped_no_consent';

-- VERIFY: parked-for-consent should be 0 now; the next 15-min tick sorts
-- the revived rows into sent / expired / re-parked.
select status, count(*) from checkout_recoveries group by 1 order by 2 desc;
