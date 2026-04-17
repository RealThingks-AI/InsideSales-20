

## Email Reply Tracking -- Automatic Sync Plan

### Problem Summary

After deep analysis of the entire email sending and tracking flow, here are all the issues found:

1. **No reply detection mechanism exists** -- The system sends emails via Microsoft Graph `sendMail` API but has zero infrastructure to detect incoming replies. No Graph webhooks, no polling, no delta queries.

2. **Graph `sendMail` returns no message metadata** -- The `sendMail` endpoint returns `202 Accepted` with an empty body. The code generates a random UUID as `message_id` (line 139 of `send-campaign-email/index.ts`) instead of capturing Graph's actual `internetMessageId` or `conversationId`. This makes thread correlation impossible.

3. **Thread view groups by contact, not email thread** -- `CampaignCommunications.tsx` line 138-157 groups all communications (emails, calls, LinkedIn) by `contact_id` rather than by actual email `thread_id`. This makes the "Threads" view misleading.

4. **"Log Reply" only manually logs -- no status propagation** -- When clicking "Log Reply", it opens the log modal pre-filled with `email_status: "Replied"` but does NOT update the original sent email's status or the `email_history` record's `reply_count`/`replied_at` fields.

5. **`email_history` reply fields never updated** -- The `email_history` table has `reply_count`, `replied_at`, `last_reply_at` columns but nothing ever writes to them.

6. **Emails sent from Contacts tab don't go through Graph** -- `CampaignContacts.tsx` and `CampaignAccountsContacts.tsx` have their own `handleSendEmail` that inserts directly into `campaign_communications` without calling the `send-campaign-email` edge function (no actual email delivery, no `delivery_status`, no `sent_via`).

### Architecture for Automatic Reply Sync

Since the user wants **automatic sync**, we need to poll the sender's mailbox via Microsoft Graph to detect replies to campaign emails. The approach:

**Two-step send** (instead of `sendMail`): Create a draft message, then send it. The draft creation returns the `internetMessageId` and `conversationId` which we store for thread correlation.

**Reply polling edge function**: A new scheduled edge function that periodically queries Graph for new messages that are replies to known campaign emails, using the stored `conversationId`.

### Implementation Plan

#### Phase 1: Capture Graph Message Metadata on Send

**File: `supabase/functions/_shared/azure-email.ts`**
- Replace `sendMail` with a two-step approach:
  1. `POST /users/{sender}/messages` -- creates a draft, returns the message object with `internetMessageId` and `conversationId`
  2. `POST /users/{sender}/messages/{id}/send` -- sends the draft
- Update `SendEmailResult` to include `graphMessageId`, `internetMessageId`, and `conversationId`

**File: `supabase/functions/send-campaign-email/index.ts`**
- Store `graphMessageId`, `internetMessageId`, and `conversationId` from the send result
- Save these in `campaign_communications.message_id` (use `internetMessageId` instead of random UUID)
- Store `conversationId` in `campaign_communications.thread_id` (currently stores a random UUID or null)

**Migration**: Add columns to `campaign_communications`:
- `graph_message_id TEXT` -- Graph internal message ID
- `internet_message_id TEXT` -- RFC 2822 Message-ID
- `conversation_id TEXT` -- Graph conversation ID for thread grouping

Add column to `email_history`:
- `internet_message_id TEXT` -- for cross-referencing

#### Phase 2: Reply Detection Edge Function

**New file: `supabase/functions/check-email-replies/index.ts`**
- Scheduled via pg_cron (every 5 minutes)
- Queries `campaign_communications` for emails sent via Graph in the last 7 days that have a `conversation_id`
- For each unique sender email + conversation_id pair, queries Graph: `GET /users/{senderEmail}/mailFolders/inbox/messages?$filter=conversationId eq '{convId}'&$orderby=receivedDateTime desc`
- For each reply found that isn't already tracked:
  - Insert a new `campaign_communications` record with `communication_type: "Email"`, `email_status: "Replied"`, `parent_id` pointing to the original, `thread_id` matching the original, `sent_via: "graph-sync"`
  - Update the original email's `email_status` to "Replied"
  - Update corresponding `email_history` record: increment `reply_count`, set `replied_at`/`last_reply_at`
  - Update `campaign_contacts` stage to "Responded" if rank is higher
  - Recompute `campaign_accounts` status

#### Phase 3: Fix Thread View to Use Real Threads

**File: `src/components/campaigns/CampaignCommunications.tsx`**
- Update the `threads` memo (line 138) to group emails by `conversation_id` or `thread_id` (for actual email threading) rather than `contact_id`
- Keep the contact-grouped view as a separate "Contact Activity" view
- Show reply chains properly with indentation in the thread view

#### Phase 4: Fix Log Reply to Update Original Email

**File: `src/components/campaigns/CampaignCommunications.tsx`**
- When logging a reply (line 416-432), after inserting the reply record:
  - Update the parent email's `email_status` to "Replied"
  - Update the matching `email_history` record's `reply_count` and `replied_at`
  - Update `campaign_contacts` stage to "Responded"

#### Phase 5: Fix Contacts Tab Email Sending

**Files: `src/components/campaigns/CampaignContacts.tsx`, `src/components/campaigns/CampaignAccountsContacts.tsx`**
- Replace direct `campaign_communications.insert` with a call to `supabase.functions.invoke("send-campaign-email", ...)` so emails are actually sent via Graph and properly tracked

#### Phase 6: Schedule the Polling Function

- Use `supabase--read_query` + SQL insert to create a pg_cron job that calls `check-email-replies` every 5 minutes
- The function authenticates with Graph using the same Azure credentials already configured

### Files Changed

| File | Change |
|------|--------|
| `supabase/functions/_shared/azure-email.ts` | Two-step send (draft + send) returning message metadata |
| `supabase/functions/send-campaign-email/index.ts` | Store Graph metadata instead of random UUIDs |
| New: `supabase/functions/check-email-replies/index.ts` | Polling function for reply detection |
| `src/components/campaigns/CampaignCommunications.tsx` | Fix thread view, fix Log Reply to update parent, fix status propagation |
| `src/components/campaigns/CampaignContacts.tsx` | Use edge function for actual email sending |
| `src/components/campaigns/CampaignAccountsContacts.tsx` | Use edge function for actual email sending |
| Migration | Add `graph_message_id`, `internet_message_id`, `conversation_id` columns |

### Technical Notes

- The Azure app registration already has `Mail.Send` application permission (confirmed by successful sends). It will also need `Mail.Read` or `Mail.ReadBasic` application permission for reading inbox replies. The user may need to grant this in Azure Portal.
- The pg_cron job will be created via SQL insert (not migration) since it contains project-specific URLs.
- The two-step send (draft + send) is slightly slower than `sendMail` but is the only way to get the `internetMessageId` before send.

