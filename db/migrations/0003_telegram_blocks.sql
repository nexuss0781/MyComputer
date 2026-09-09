-- 0003_telegram_blocks.sql
-- Add Telegram file_id so cold reads can download the exact chunk from the
-- Bot API server. The content chunk bytes stay in `data` on the hot path; a
-- future prune step nulls `data` and relies on `file_id` + `tg_msg_id`.
-- Idempotent.

ALTER TABLE public.blocks ADD COLUMN IF NOT EXISTS file_id text;
