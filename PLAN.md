# SalesFlow CRM — Implementation Plan (Phases 1–3)

**Status:** Approved for implementation planning  
**Scope:** Customer 360, order context, customer-care timeline, ticket/SLA, website/webchat automation và Facebook Messenger  
**Postponed:** Zalo OA, telephony, CSV import, advanced analytics, accounting/inventory  
**Governing rules:** `AGENTS.md` generated from `SALESFLOW_AGENT_BLUEPRINT.md`

## 1. Outcome

Sau Phase 3, một SME có thể:

1. Tạo workspace, mời nhân viên và phân quyền.
2. Tạo/nhận khách hàng từ nhập tay, website form, webchat và Facebook Messenger.
3. Xem Customer 360 gồm contact, orders, notes, calls, conversations, tickets và tasks.
4. Tạo/giải quyết ticket với first-response và resolution SLA.
5. Tự động assign, tạo task, gửi email/thông báo theo sự kiện.
6. Trả lời webchat/Messenger từ một inbox và giữ lịch sử trên hồ sơ khách hàng.

### Demo journey cuối

```text
Khách gửi website form
→ tạo PROSPECT và assign agent
→ khách nhắn webchat/Messenger
→ identity được gắn vào Customer 360
→ agent xem order cũ và toàn bộ timeline
→ tạo ticket “giao sai sản phẩm”
→ SLA bắt đầu và agent trả lời
→ ticket PENDING_CUSTOMER rồi RESOLVED
→ automation tạo task hỏi thăm sau 2 ngày
```

## 2. Scope discipline

### Làm trong kế hoạch

- Full-stack web application, backend là trọng tâm.
- Order là dữ liệu ngữ cảnh CRM, có manual create và adapter contract.
- Call ở Phase 1 là manual call log, không kết nối tổng đài.
- Email Phase 2 dùng provider adapter; local dùng Mailpit/fake.
- Facebook Phase 3 kết nối Page qua flow chính thức và webhook.

### Không làm

- Warehouse, delivery orchestration, tax/payment/accounting/invoice pháp lý.
- Zalo OA, telephony provider, bulk CSV migration.
- Campaign marketing hàng loạt hoặc AI chatbot.
- Custom object/workflow scripting tùy ý.
- Microservices, Kubernetes hoặc event sourcing.

Nếu agent phát hiện nhu cầu ngoài phạm vi, ghi vào `docs/PROJECT_STATE.md` dưới `Deferred`, không implement.

## 3. Architecture plan

### Runtime

```text
React Web
   │ REST/SSE
Express API ───────────── PostgreSQL
   │                          ▲
   ├── Redis/BullMQ ── Worker─┤
   │                          ├── SMTP/Email adapter
   │                          └── Meta Graph/Messenger adapter
   └── Provider webhooks → durable InboxEvent
```

- Modular monolith, API và worker tách process.
- PostgreSQL là source of truth.
- Redis dùng queue/rate limit/cache ngắn; mất Redis không được làm mất inbound data đã nhận.
- Transactional outbox cho internal domain event.
- Provider inbound được verify và persist uniquely trước khi xử lý async.

### Source layout

```text
apps/api/src/modules/{identity-tenancy,customers,orders,interactions,tickets,automations,channels}
apps/worker/src/{consumers,schedulers,providers}
apps/web/src/features/{auth,customers,orders,timeline,tickets,automation,inbox,settings}
packages/{config,database,contracts,observability,test-utils}
```

### Data relationship

```text
Workspace
├── Membership/Team
├── Customer
│   ├── ContactPoint
│   ├── ChannelIdentity
│   ├── Order ── OrderItem
│   ├── Interaction
│   ├── Task
│   ├── Ticket
│   └── Conversation ── Message
├── SLA Policy
├── Automation Rule/Execution
└── Channel Connection/Inbox Event
```

## 4. Delivery sequence

```text
Phase 1
F00 → F01 → F02 → F03 → F04 → F05
                          │
Phase 2                  ▼
                    F07 Website/Inbox
                    F06 Automation/Email
                          │
Phase 3                  ▼
                    F08 Messenger
```

F06 có thể bắt đầu sau F04/F05 contracts ổn định và chạy song song phần UI của F07. F08 chỉ bắt đầu khi inbox/channel abstractions của F07 đã được integration-test.

---

# PHASE 1 — Core Customer Service CRM

**Exit outcome:** một đội CSKH nhỏ sử dụng được hệ thống bằng dữ liệu nhập tay; Customer 360, orders, timeline, tasks và ticket/SLA hoạt động end-to-end.

## P1-M0 — Foundation (F00)

### Deliverables

- pnpm monorepo; API, worker và React/Vite web shell.
- TypeScript strict, lint/format/build.
- Express factory, Zod validation, OpenAPI, typed errors, request ID, Pino redaction.
- Drizzle/PostgreSQL migration + transaction helper.
- Redis/BullMQ registry, graceful worker lifecycle.
- Base audit/outbox tables và publisher skeleton.
- Docker Compose, Testcontainers, CI và safe env config.
- Module skeletons, READMEs, ADRs, `docs/PROJECT_STATE.md`.

### Release gate

- Clean checkout → install → migrate → test → build thành công.
- Health readiness đúng khi PostgreSQL/Redis up/down.
- Secret redaction và transaction rollback có tests.
- Chưa có business logic.

## P1-M1 — Identity, Workspace & RBAC (F01)

### Backend

- User/register/login/refresh/logout.
- Opaque refresh rotation và reuse detection.
- Workspace creation; membership/invitation/team/availability.
- OWNER, ADMIN, CS_MANAGER, AGENT, SALES, VIEWER Policies.
- Audit/outbox cho membership/security changes.

### Frontend

- Login/register.
- Workspace onboarding/switcher.
- Invitation acceptance.
- Member/team settings và permission-aware navigation.

### Release gate

- Register → workspace → invite → accept Playwright/API E2E.
- Cross-tenant UUID access trả 404.
- Deactivated member bị chặn request tiếp theo.
- Concurrent invitation/slug behavior deterministic.

## P1-M2 — Customer 360 & Identity Resolution (F02)

### Backend

- Customer PERSON/ORGANIZATION; lifecycle PROSPECT/CUSTOMER/INACTIVE/ARCHIVED.
- ContactPoint PHONE/EMAIL/ADDRESS với normalized value.
- Owner/team/source/tag/consent/address/preferences.
- Exact duplicate candidate và ambiguous review.
- ChannelIdentity contract dùng cho Phase 2/3.
- Manual merge transaction: survivor, re-parent relations, alias/merge log.
- Cursor search/list, optimistic version và PII visibility.

### Frontend

- Customer list/filter/manual create.
- Customer 360 shell: Overview, Timeline, Orders, Tickets, Conversations, Tasks.
- Duplicate warning, review và merge confirmation.

### Release gate

- Hai workspace có cùng email hợp lệ.
- Concurrent exact identity create không tạo record rác.
- Ambiguous email/phone không auto-merge.
- Merge bảo toàn relations và audit.
- Viewer/Agent/Manager nhìn đúng trường dữ liệu.

## P1-M3 — Product & Order Context (F03)

### Backend

- Minimal Product catalog: sku, name, active, default price.
- Order + immutable line-item snapshot.
- Status DRAFT/CONFIRMED/FULFILLED/CANCELLED/REFUNDED.
- Server-calculated totals; guarded transitions; external ID idempotency.
- First valid order chuyển PROSPECT → CUSTOMER atomically.
- Order event xuất timeline/outbox.

### Frontend

- Product settings tối thiểu.
- Order list/detail/manual create.
- Orders tab trong Customer 360.

### Release gate

- Server totals khớp fixtures tiền tệ.
- Invalid transition/update confirmed order bị chặn.
- Duplicate external order idempotent.
- Không xuất hiện inventory/shipping/accounting logic.

## P1-M4 — Timeline, Manual CSKH & Tasks (F04)

### Backend

- Interaction NOTE/CALL/EMAIL/MESSAGE/MEETING/ORDER_EVENT/TICKET_EVENT/SYSTEM.
- Manual call log: direction, time, duration, outcome, summary.
- Note edit window/audit; void/redact với permission và reason.
- Task assign/due/complete/overdue.
- Unified timeline query theo occurredAt+ID và visibility policy.

### Frontend

- Timeline filter/type/channel.
- Form add note/log call/email/meeting.
- Create/complete tasks.
- “My work”: due today và overdue.

### Release gate

- Order/note/call/task events xuất hiện đúng timeline.
- Timeline cursor không thiếu/lặp item khi cùng timestamp.
- Void/redact không phá audit/history.
- Task overdue dựa DB truth.

## P1-M5 — Ticket & SLA (F05)

### Backend

- Ticket number + UUID; priority LOW/NORMAL/HIGH/URGENT.
- NEW/OPEN/PENDING_CUSTOMER/RESOLVED/CLOSED state machine.
- Owner/team/category/customer/source conversation.
- First-response SLA và requester-wait resolution SLA theo priority, business hours/timezone.
- PENDING_CUSTOMER pause resolution clock; customer reply resume/reopen.
- Warning/breach schedulers idempotent.
- Ticket reply/comment model phân biệt PUBLIC_REPLY và INTERNAL_NOTE.

### Frontend

- Ticket queue/filter.
- Ticket detail: customer context, conversation/comments, internal notes.
- Assign/status/reply/resolution summary.
- SLA countdown, paused/breached indicators.
- SLA policy settings.

### Release gate

- First public agent reply fulfill SLA once.
- Internal note không fulfill first-response SLA.
- Pause/resume/reopen chính xác với fake clock.
- Worker restart/job chạy muộn không làm sai deadline.
- Ticket events hiện trên Customer 360.

## Phase 1 integration test

```text
Admin creates workspace and agents
→ Agent manually creates PROSPECT
→ Sales creates confirmed order
→ Customer becomes CUSTOMER
→ Agent logs call and follow-up task
→ Agent opens urgent ticket
→ Agent adds internal note then public reply
→ first-response SLA completes
→ ticket waits for customer then resolves
→ Customer 360 shows the entire history
```

---

# PHASE 2 — Website Omnichannel & Automation

**Exit outcome:** khách có thể tự để lại thông tin/nhắn webchat; agent trả lời trong inbox; hệ thống tự assign, tạo task và gửi notification/email.

## P2-M1 — Channel/Inbox Foundation (F07 core)

### Backend model

- ChannelConnection, ChannelIdentity, Conversation, Participant, Message, InboxEvent.
- Conversation OPEN/PENDING/CLOSED, owner/team/unread/lastMessageAt/version.
- Message INBOUND/OUTBOUND + sent/delivered/read/failed.
- Durable inbound pipeline: validate → unique persist → ack → worker normalize → resolve customer → timeline.

### Frontend

- Inbox split view: conversation list, thread, customer side panel.
- Assign/close/reopen conversation.
- Link pending identity to existing customer hoặc create prospect.
- Create/link ticket from conversation.

### Gate

Duplicate inbound events/messages idempotent; concurrent assignment uses version conflict; conversation/customer/ticket links tenant-safe.

## P2-M2 — Website Form

### Backend

- Admin-defined form: title, allowed/required fields, source, consent text, assignment/default-ticket policy, allowed origins, PUBLISHED state.
- Public opaque form ID; no workspace API key in browser.
- Rate limit, honeypot, payload cap, optional CAPTCHA port.
- Capture UTM/referrer/landingPage/consentAt.
- Submission calls Customer resolution, assignment và outbox.

### Frontend

- Form settings/preview/publish.
- Hosted public page `/forms/:publicId`.
- Success/error states không tiết lộ duplicate/customer internals.

### Gate

Public submission tạo/ghép Customer đúng; source/consent attribution lưu; spam controls test; refresh không double-submit.

## P2-M3 — Webchat

### Backend

- Hosted chat/widget session với anonymous visitor identity.
- Inbound message persisted trước async processing.
- Customer link khi visitor cung cấp email/phone; ambiguous identity vào review.
- Agent reply, unread/read state và optional ticket creation.

### Frontend

- Hosted chat page/widget demo.
- Inbox live update bằng SSE hoặc WebSocket; chọn một và ghi ADR.
- Customer context/ticket action ngay cạnh conversation.

### Gate

Unknown visitor không mất message; reconnect không duplicate; agent sees and replies; timeline links đúng sau identity resolution.

## P2-M4 — Automation, Notification & Email (F06)

### Rules MVP

Triggers: CUSTOMER_CREATED, ORDER_CONFIRMED/FULFILLED, TICKET_CREATED/STATUS_CHANGED/SLA_WARNING/BREACHED, TASK_OVERDUE.

Conditions: allowlisted customer/order/ticket fields với ALL/ANY và equals/not-equals/contains/greater/less/empty.

Actions: assign user/team, add/remove tag, create task, in-app notification, email adapter. Outbound channel message giữ disabled đến khi connector contract cho phép.

### Backend/UI

- Versioned rule schema, dry-run, execution/action log, recursion guard, retry/replay.
- Notification center/unread.
- SMTP adapter; Mailpit/fake local.
- Rule builder dạng form, không canvas.

### Gate

- Order fulfilled tạo follow-up task.
- SLA warning notify Manager.
- Duplicate event không duplicate effects.
- Archived/no-consent customer bị chặn outbound phù hợp.
- Retry/replay giữ lịch sử, dry-run không mutate.

## Phase 2 integration test

```text
Visitor submits website form and opens webchat
→ Customer resolution links both identities
→ Conversation assigned to Agent
→ Agent creates ticket and replies
→ SLA event triggers Manager notification
→ ticket resolved
→ automation creates follow-up task/email
```

---

# PHASE 3 — Facebook Messenger

**Exit outcome:** Admin kết nối Facebook Page, message mới vào Inbox, identity gắn Customer 360 và agent trả lời khi provider policy cho phép.

## P3-M0 — Mandatory provider research gate

Trước code, agent phải dùng tài liệu Meta chính thức hiện hành và tạo ADR:

- API version được pin.
- App mode, permissions và app-review requirements.
- OAuth/Facebook Login flow, Page selection và Page access token lifecycle.
- Webhook verification/signature requirements.
- Message send policy/window và development/test limitations.
- Khả năng backfill thực tế; không hứa full history nếu API không hỗ trợ.

Nếu credential/app/Page test không có, vẫn implement adapter bằng sanitized fixtures/fake server nhưng đánh integration-live là BLOCKED, không giả pass.

## P3-M1 — Connection lifecycle

- Modes PLATFORM_MANAGED_APP và optional BRING_YOUR_OWN_APP.
- OAuth state/CSRF protection; PKCE nếu supported/relevant.
- Connect/select Page; encrypted access token/app secret; write-only secret.
- DISCONNECTED/CONNECTING/ACTIVE/NEEDS_REAUTH/ERROR/DISABLED.
- Token expiry/revocation chuyển NEEDS_REAUTH và notify Admin.
- Settings UI hiển thị Page, status, last event/sync error; không hiển thị token.

## P3-M2 — Webhook ingestion

- Verification endpoint và signature validation trước xử lý.
- Persist raw-minimal/redacted InboxEvent uniquely, acknowledge nhanh.
- Worker anti-corruption adapter chuyển provider payload thành common Message/Event contract.
- Poison/unknown event vào review state; bounded retry.
- External event/message ID unique theo connection.

## P3-M3 — Customer resolution and inbox

- Map `connection + externalUserId` → ChannelIdentity → Customer.
- Unknown sender tạo PROSPECT/pending identity theo workspace policy.
- Manual link/merge khi nhân viên xác nhận phone/email.
- Messenger conversation/message xuất hiện cùng webchat/manual interaction trên Customer 360.
- Delivery/read events cập nhật message idempotently.

## P3-M4 — Agent reply

- Agent reply từ Inbox qua Messenger adapter.
- Enforce role, active connection, consent/policy state và provider send rules.
- Persist outbound intent trước delivery; worker send/retry; sent/failed status quan sát được.
- Permanent provider rejection không retry vô hạn; hiển thị safe reason/action cho agent.

## Phase 3 release gate

- Invalid verification/signature bị reject.
- Duplicate webhook không duplicate InboxEvent/message/interaction.
- Known/unknown/ambiguous identity scenarios pass.
- Token revoke/expiry visible và không silently drop inbound.
- Sanitized fixture contract tests pass.
- Nếu có test Page/credential: live smoke test connect → receive → reply được ghi evidence riêng.

---

## 5. Cross-phase API groups

- `/api/v1/auth`, `/workspaces`, `/members`, `/teams`
- `/api/v1/workspaces/:workspaceId/customers`
- `/customers/:customerId/orders|interactions|tasks|tickets|conversations`
- `/api/v1/workspaces/:workspaceId/tickets|sla-policies`
- `/api/v1/workspaces/:workspaceId/automations|notifications`
- `/api/v1/workspaces/:workspaceId/channel-connections|conversations`
- `/api/v1/public/forms/:publicId/submissions`
- `/api/v1/public/webchat/...`
- `/api/v1/webhooks/meta/...`

State transition dùng action endpoint rõ (`assign`, `resolve`, `reopen`, `merge`, `publish`, `connect`, `disconnect`) thay vì PATCH mơ hồ.

## 6. Main risks and controls

| Risk                           | Control                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Scope thành MISA clone         | Order chỉ là CRM context; Phase 4 explicitly postponed.                      |
| Tenant data leak               | Repository signatures require workspaceId; cross-tenant integration suite.   |
| Customer duplicate/merge sai   | Exact matching only, ambiguous review, transactional manual merge.           |
| SLA sai khi worker down        | Persisted deadlines/pause intervals; jobs only remind/escalate.              |
| Message duplicate/out-of-order | Unique provider IDs, idempotent consumers, provider timestamps + stable IDs. |
| Provider API thay đổi          | Phase 3 research ADR, pinned version, anti-corruption adapter.               |
| Secret/PII leak                | Encryption, write-only secrets, structured redaction and tests.              |
| Frontend làm sau cùng          | Mỗi milestone backend đi kèm UI slice và E2E.                                |

## 7. Agent execution protocol

### Bootstrap

```text
MODE=BOOTSTRAP. Đọc AGENTS.md và PLAN.md, rồi chỉ triển khai P1-M0/F00.
Không implement business feature. Chạy gates và cập nhật docs/PROJECT_STATE.md.
```

### Feature milestone

```text
MODE=FEATURE. Implement P1-M2 / FEATURE F02.
Đọc section tương ứng trong AGENTS.md và PLAN.md, PROJECT_STATE, contracts/code/tests
liên quan. Không đọc lại toàn bộ hoặc làm milestone kế tiếp. Chạy release gate và
cập nhật PROJECT_STATE bằng evidence thực tế.
```

### Review

```text
MODE=REVIEW. Review P1-M2 against AGENTS.md, PLAN.md, current diff and tests.
Prioritize business correctness, tenant isolation, authorization, transaction,
idempotency, provider security and missing tests. Do not modify code.
```

## 8. Completion boundary

Project scope này hoàn thành khi Phase 1–3 gates pass và demo journey chạy được. Không tự tiếp tục sang Zalo, telephony, CSV hoặc analytics nâng cao. Những phần đó cần một plan mới và quyết định riêng.
