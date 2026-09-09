# SalesFlow — Omnichannel Customer Service CRM Agent Blueprint

> Đổi tên file này thành `AGENTS.md` và đặt ở root repository. Đây là file duy nhất cần đưa cho agent đầu tiên. Các tài liệu SalesFlow cũ không còn là nguồn sự thật.

> **STATUS: APPROVED FOR PHASES 1–3.** Chỉ triển khai F00–F08 theo `PLAN.md`. F09 và mọi tính năng Phase 4 đang postponed.

## 0. Cách sử dụng

### Lượt đầu

Gửi cho agent prompt ở cuối file với `MODE=BOOTSTRAP`. Agent đọc toàn bộ file một lần, dựng F00, tạo module README và `docs/PROJECT_STATE.md`.

### Các lượt sau

Chỉ gửi `MODE=FEATURE. Implement Fxx theo AGENTS.md.` Agent đọc:

1. CORE rules.
2. Section Fxx.
3. `docs/PROJECT_STATE.md`.
4. Source, contracts, migration và tests liên quan.

Agent chỉ tra section dependency khi code/public contract hiện tại chưa đủ rõ; không đọc lại toàn bộ blueprint.

---

# CORE-START

## 1. Product definition

SalesFlow là **CRM chăm sóc khách hàng đa kênh cho SME**, lấy **Customer 360** làm trung tâm.

Một hồ sơ khách hàng phải trả lời được ngay:

- Khách là ai, liên hệ bằng kênh nào và thuộc nhóm nào?
- Đã mua gì, đơn hàng gần nhất và tổng giá trị là bao nhiêu?
- Đã gọi thủ công, email, webchat hoặc nhắn Messenger những gì?
- Đang có ticket/phàn nàn nào, ai xử lý và SLA còn bao lâu?
- Việc chăm sóc tiếp theo là gì?

### Luồng giá trị chính

```text
Website/Manual/Webchat/Facebook Messenger
                    ↓
          Identity Resolution
                    ↓
             Customer 360
       ┌────────────┼────────────┐
     Orders     Interactions    Tickets
       └────────────┼────────────┘
             Automation/SLA
                    ↓
           Omnichannel Inbox
```

Lead không còn là aggregate trung tâm. Khách mới có `lifecycle = PROSPECT`; khi phát sinh đơn hàng hợp lệ hoặc được nhân viên xác nhận thì thành `CUSTOMER`.

### Phạm vi MVP

- Customer data, contact points, tags, consent, ownership và duplicate/merge.
- Lịch sử đơn hàng ở mức CRM, không làm kho/kế toán.
- Interaction timeline: note, call log, email/message metadata, order và ticket events.
- Ticket CSKH với first-response/resolution SLA.
- Task/reminder và automation.
- Omnichannel inbox foundation; website/webchat trước, Facebook Messenger ở Phase 3.
- React frontend đầy đủ cho các luồng trên.

Ngoài MVP: kế toán/công nợ/hóa đơn điện tử, tồn kho/giao vận thật, PBX tự xây, marketing campaign hàng loạt, AI chatbot/scoring, mobile native, microservices/Kubernetes.

## 2. Actors và permission

- **OWNER:** toàn quyền workspace, connection và ownership transfer.
- **ADMIN:** member/team, customer schema/configuration, channels, automation, API key.
- **CS_MANAGER:** xem toàn bộ customer/conversation/ticket/order; assign, merge, reopen/close và xem reports.
- **AGENT:** xử lý customer/conversation/ticket được giao hoặc team-visible; tạo interaction/task.
- **SALES:** quản lý customer/order được giao; đọc ticket/timeline theo policy.
- **VIEWER:** chỉ đọc dữ liệu được phép.
- **PLATFORM_ADMIN:** vận hành hệ thống; truy cập tenant phải có reason và audit.

Permission được enforce tại application use case bằng Policy, không chỉ route/UI. Tài nguyên ngoài workspace trả 404.

## 3. Global business invariants

- Mọi entity nghiệp vụ có `workspaceId`; mọi query/mutation tenant-scoped.
- Customer là nguồn sự thật danh tính; Order, Ticket, Conversation, Interaction và Task tham chiếu Customer.
- External event có unique provider identity/event ID; webhook/retry không được tạo bản ghi lặp.
- Timestamp lưu UTC, hiển thị theo timezone workspace; tiền dùng integer minor units + ISO currency.
- Customer/Ticket/Order/Automation dùng optimistic `version`; stale mutation trả `409 VERSION_CONFLICT`.
- Mutation quan trọng lưu state + audit + outbox trong cùng PostgreSQL transaction.
- Không gọi provider/email/webhook/Redis trước DB commit.
- Audit append-only; message/order/ticket history không hard-delete, chỉ archive/redact/void theo quyền và lưu lý do.
- List phân trang, sort ổn định, tối đa 100 items.
- API command hỗ trợ `Idempotency-Key` scoped workspace + actor/connection + route, giữ tối thiểu 24 giờ.
- Worker/event xử lý at-least-once; consumer idempotent.
- Raw PII chỉ hiển thị cho role được phép; secret/token không xuất hiện trong log/error/audit.

## 4. Integration credential model — bắt buộc hiểu đúng

`appSecret` một mình **không đủ** để đọc tin nhắn. Một connector thường cần app registration, OAuth authorization của quản trị viên Page/OA, access token, webhook subscription/verification và permission do nhà cung cấp cấp.

SalesFlow hỗ trợ hai mode:

1. **PLATFORM_MANAGED_APP:** chủ SalesFlow đăng ký Meta app một lần; tenant bấm Connect và cấp quyền Facebook Page qua OAuth. Đây là mode SaaS khuyến nghị.
2. **BRING_YOUR_OWN_APP:** tenant Admin nhập appId/appSecret ở advanced settings, sau đó vẫn phải chạy OAuth để lấy token và chọn Page/OA. Secret được mã hóa, write-only, không trả lại qua API.

Không hứa “kéo toàn bộ lịch sử cũ”. Backfill phụ thuộc API, permission và retention của từng provider. Agent implement connector MUST đọc tài liệu chính thức hiện hành, pin API version/config và ghi ADR; không đoán permission hoặc messaging window từ blueprint.

## 5. Architecture và stack

- Node.js active LTS được xác minh và pin lúc bootstrap.
- pnpm workspaces, TypeScript strict.
- Backend: Express.js 5, Zod, OpenAPI 3.1, Pino.
- Data: PostgreSQL + Drizzle ORM.
- Async: Redis + BullMQ + Transactional Outbox.
- Frontend: React + Vite, React Router, TanStack Query, React Hook Form + Zod.
- Tests: Vitest, Supertest, Testcontainers, Testing Library, Playwright cho critical E2E.
- Local: Docker Compose cho PostgreSQL, Redis, Mailpit.
- CI: frozen install, lint, typecheck, unit/integration, build, migration và contract check.

```text
apps/
├── api/src/modules/
│   ├── identity-tenancy/
│   ├── customers/
│   ├── orders/
│   ├── interactions/
│   ├── tickets/
│   ├── automations/
│   └── channels/
├── worker/src/
└── web/src/features/
packages/
├── config/
├── database/
├── contracts/
├── observability/
└── test-utils/
docs/
├── adr/
└── PROJECT_STATE.md
```

Backend module dùng `domain/application/infrastructure/presentation`, có `README.md` và chỉ export public surface qua `index.ts`. MVP là modular monolith với API và worker tách process.

## 6. Patterns và transaction model

- Repository cho aggregate/query quan trọng.
- Unit of Work/transaction boundary cho state + audit + outbox.
- Policy cho authorization/visibility.
- Strategy cho SLA, assignment và provider connector.
- Adapter cho Messenger, webchat, email và storage.
- Specification + Handler Registry cho automation.
- Transactional Outbox + Idempotent Consumer cho async.
- Anti-Corruption Layer trong channel adapters: provider payload không đi thẳng vào domain.

Inbound flow chuẩn:

```text
Verify provider request
→ persist InboxEvent uniquely
→ acknowledge nhanh
→ worker normalize payload
→ resolve channel identity/customer
→ create message/interaction/ticket action
→ audit + outbox
```

Provider timeout không được làm mất inbound event. Poison event vào failed/review state, không retry vô hạn.

## 7. API/error/comment conventions

Base `/api/v1`. Success `{data, meta:{requestId}}`; error `{error:{code,message,details,requestId}}`. Dùng 201 create, 202 async accepted, 401, 403, 404 hidden resource, 409 conflict, 422 validation, 429 limit.

Controller mỏng. Domain/application không import Express, Drizzle hoặc BullMQ types. Typed errors map tại presentation.

Comment/JSDoc bắt buộc cho:

- Business invariant khó thấy.
- Identity resolution/merge consequence.
- Transaction, row/advisory lock, optimistic lock và race prevention.
- Webhook verification, token refresh, idempotency/retry.
- SLA calendar và pause/resume.
- Security/redaction và query/index optimization.

Comment giải thích **why/rule/trade-off**, không kể lại cú pháp. Cấm `any`/non-null assertion để né thiết kế. TODO phải có task ID và lý do.

## 8. Security baseline

- Password Argon2id; access token 15 phút; opaque refresh rotation/reuse detection.
- Integration secrets/tokens encrypted at rest bằng versioned encryption key; raw secret write-only.
- Provider webhook verify challenge/signature theo tài liệu chính thức trước xử lý.
- Rate limit auth, public form/chat, outbound test và provider webhook abuse path.
- CORS allowlist, payload/upload cap, parameterized query, security headers.
- Outbound URL chống SSRF: HTTPS production, chặn loopback/private/link-local, revalidate redirect/DNS, timeout/size cap.
- Message content và phone/email là PII: log ID/metadata, không log raw body.
- Recording URL/file có permission riêng, short-lived access; không public bucket.

## 9. Definition of Done

- Happy path, validation, permission, cross-tenant, state conflict được test.
- Persistence/transaction/queue/concurrency dùng integration test với PostgreSQL/Redis thật.
- Provider tests dùng recorded sanitized fixtures/fake server, không gọi internet trong CI.
- OpenAPI/event contract/module README/migration được cập nhật cùng code.
- Lint, typecheck, relevant tests, build pass; migration chạy từ DB trắng.
- Agent cập nhật `docs/PROJECT_STATE.md` bằng feature, contract/schema, migration, tests, ADR, risks và next dependency.
- Task không được báo Done nếu chưa chạy verification thật.

# CORE-END

---

## FEATURE F00 — Project Foundation

**Goal:** dựng base full-stack, module boundaries và quality gates.  
**Dependencies:** none.  
**Không làm:** business logic F01–F09.

### Tasks

1. Tạo pnpm monorepo, strict TypeScript, lint/format/build scripts.
2. Tạo Express app factory, request ID, Zod validation, error envelope, Pino redaction, live/ready health.
3. Tạo Drizzle/PostgreSQL migration + transaction helper.
4. Tạo Redis/BullMQ registry, worker lifecycle/graceful shutdown.
5. Tạo audit/outbox base tables và publisher skeleton an toàn.
6. Tạo React/Vite shell, routing/layout/error boundary, API client và test setup.
7. Tạo Testcontainers, Docker Compose, CI, `.env.example`, root README.
8. Tạo module skeletons F01–F09, module README, ADR token transport/outbox và `docs/PROJECT_STATE.md`.

### Acceptance

API/worker/web build; health phản ánh DB/Redis; invalid env fail-fast; log redact test; migration từ DB trắng; transaction rollback; idempotent demo job; frontend smoke test; CI pass. Không có business feature bị implement sớm.

---

## FEATURE F01 — Identity, Workspace, Teams & RBAC

**Goal:** account/session, tenant và phân quyền.  
**Depends on:** F00.

### Rules

- OWNER/ADMIN/CS_MANAGER/AGENT/SALES/VIEWER theo CORE.
- Workspace creation atomically tạo Owner và default config hook.
- Email normalized unique; invitation 7 ngày, one-time, revocable.
- Owner không rời khi chưa transfer; Admin không quản lý Owner.
- Deactivate member chặn truy cập nhưng không xóa ownership/history.
- Team member có availability; unavailable không auto-assign.

### UI/API

Register/login/refresh/logout; onboarding; member/invitation/team settings. Refresh token hash+rotation. Cross-tenant trả 404.

### Acceptance

Register → workspace → invite → accept E2E; refresh reuse revoke; concurrent invite/slug safe; RBAC và tenant isolation suite pass.

---

## FEATURE F02 — Customer 360 & Data Management

**Goal:** hợp nhất dữ liệu khách hàng và cung cấp hồ sơ 360 làm trung tâm hệ thống.  
**Depends on:** F01.

### Customer model

- Type PERSON hoặc ORGANIZATION.
- Lifecycle PROSPECT, CUSTOMER, INACTIVE, ARCHIVED.
- Basic profile, owner/team, source, tags, addresses, preferences, consent, version.
- ContactPoint: PHONE/EMAIL/ADDRESS, normalized value, primary, verifiedAt.
- ChannelIdentity: provider/connection/externalUserId/display metadata → customer.

### Rules

- Nhập tay cần name/company hoặc ít nhất một contact point.
- Email lowercase+trim; phone normalize theo default country qua thư viện ổn định.
- Exact duplicate candidate theo phone/email trong workspace; không fuzzy name tự động.
- Nếu email trỏ Customer A nhưng phone trỏ B → NEEDS_REVIEW, không merge.
- Inbound channel identity đã liên kết luôn thắng heuristic email/phone.
- Inbound chưa match tạo PROSPECT shell hoặc pending identity theo source policy; không bỏ tin nhắn.
- Manual merge chỉ CS_MANAGER/ADMIN: chọn survivor, re-parent orders/tickets/conversations/interactions transactionally, giữ alias/merge log; không unmerge trong MVP.
- Customer tự thành CUSTOMER khi Order CONFIRMED/FULFILLED lần đầu; Manager có thể chuyển thủ công với audit.
- Archive không xóa lịch sử và không nhận outbound automation mới.

### UI/API

Customer list/filter/import-preview shell, manual create, profile 360 tabs: Overview, Timeline, Orders, Tickets, Conversations, Tasks. Merge-review screen. API CRUD/search/merge/archive/restore.

### Acceptance

Hai tenant dùng cùng email hợp lệ; duplicate/ambiguous cases đúng; concurrent identity resolve không tạo customer/channel identity lặp; merge bảo toàn toàn bộ relations/audit; stale version 409.

---

## FEATURE F03 — Product & Order History

**Goal:** biết khách đã mua gì và giá trị giao dịch, không biến CRM thành ERP.  
**Depends on:** F02.

### Model và rules

- Product: sku, name, active, default price/currency; chỉ catalog tối thiểu.
- Order: source, externalOrderId, customer, status DRAFT/CONFIRMED/FULFILLED/CANCELLED/REFUNDED, line-item snapshot, subtotal/discount/total minor units, placedAt/version.
- Tổng tiền server tính từ line items; client không quyết định total.
- CONFIRMED/FULFILLED order không sửa tùy tiện; correction qua cancel/refund hoặc explicit adjustment có audit.
- External order unique theo workspace + source + externalOrderId; repeated webhook/import idempotent.
- CRM không quản lý tồn kho, shipping execution, tax engine, payment settlement hoặc invoice pháp lý.
- Order create/status change xuất timeline interaction và outbox event.

### UI/API

Product settings; order list/detail/manual create; orders tab trên Customer 360; adapter contract để sau nhận order từ hệ thống bán hàng.

### Acceptance

Server totals đúng; invalid transition bị chặn; external duplicate không tạo order mới; first confirmed order đổi PROSPECT→CUSTOMER atomically; order xuất hiện đúng timeline.

---

## FEATURE F04 — Interaction Timeline, Task & Manual CSKH

**Goal:** gom ghi chú, cuộc gọi, tin nhắn, email, order/ticket events theo thời gian.  
**Depends on:** F02; F03 để hiện order events.

### Model và rules

- Interaction types NOTE, CALL, EMAIL, MESSAGE, MEETING, ORDER_EVENT, TICKET_EVENT, SYSTEM.
- Origin MANUAL/WEBCHAT/MESSENGER/ZALO/TELEPHONY/EMAIL/SYSTEM.
- Interaction immutable sau finalize; note tác giả sửa trong 15 phút, sau đó Manager sửa có audit diff.
- Completed call/message không hard-delete; redact/void cần permission + reason.
- Task có customer, optional ticket/order, assignee, title, dueAt, status; complete lưu actor/time.
- Timeline dùng cursor pagination, stable order `occurredAt + id`; visibility/PII policy áp dụng trước response.
- Manual call log lưu direction, startedAt, duration, outcome, summary; recording là metadata/secure reference, không bắt buộc.

### UI/API

Unified timeline trên Customer 360; add note/log call/email/meeting; create/complete task; filter channel/type. Agent dashboard “việc hôm nay/quá hạn”.

### Acceptance

Mọi nguồn hiển thị theo một timeline nhưng vẫn giữ source/external ID; tenant/PII policy đúng; task overdue tính từ DB; void/redact giữ audit.

---

## FEATURE F05 — Customer Support Ticket & SLA

**Goal:** theo dõi yêu cầu/phàn nàn đến khi giải quyết với cam kết phản hồi và xử lý.  
**Depends on:** F02, F04.

### Ticket model

- Status NEW, OPEN, PENDING_CUSTOMER, RESOLVED, CLOSED.
- Priority LOW, NORMAL, HIGH, URGENT.
- Customer, requester channel identity, subject, description, owner/team, category, source conversation, firstRespondedAt, resolvedAt, SLA deadlines, version.

### Rules

- Ticket number unique dễ đọc trong workspace nhưng API dùng UUID.
- NEW→OPEN khi agent nhận; agent reply đầu tiên đặt firstRespondedAt once/idempotent.
- RESOLVED có resolution summary; CLOSED chỉ sau resolved hoặc Manager override có reason.
- Reopen CLOSED/RESOLVED khi khách phản hồi lại hoặc Manager thao tác; ghi reason/count.
- SLA policy theo priority/channel, business hours/timezone: first-response và resolution targets.
- Resolution SLA pause khi PENDING_CUSTOMER, resume khi khách trả lời; first-response SLA không pause.
- Job chỉ nhắc/escalate; breach truth tính từ persisted deadline/pause intervals và current time.
- Ticket assignment/reassignment và mọi status change tạo timeline event/audit/outbox.

### UI/API

Ticket queue/filter, ticket detail với conversation/timeline, assign/reply/change status, SLA countdown/breach badge, policy settings.

### Acceptance

Inbound conversation có thể tạo/link ticket; first response concurrent chỉ set một lần; pause/resume calendar đúng qua fake clock; worker restart không làm sai SLA; overdue escalation idempotent.

---

## FEATURE F06 — Automation & Proactive Care

**Goal:** gửi nhắc việc/thông báo hoặc chăm sóc theo kịch bản có sẵn.  
**Depends on:** F02–F05, outbox F00.

### Model và rules

`WHEN trigger IF ALL|ANY conditions THEN ordered actions`, JSON allowlist, version immutable.

Triggers: CUSTOMER_CREATED/TAGGED, ORDER_CONFIRMED/FULFILLED, TICKET_CREATED/STATUS_CHANGED/SLA_WARNING/BREACHED, TASK_OVERDUE, CUSTOMER_BIRTHDAY scheduler.

Actions: assign user/team, add/remove tag, create task, in-app notification, email adapter, send channel message only when connector/policy permits, approved outbound webhook.

- Không chạy user JavaScript/SQL.
- Tối đa 10 actions/rule, 20 active rules/workspace, chain depth 5.
- Unique ruleVersion + rootEvent + target chống chạy lặp.
- Transient timeout/429/5xx retry exponential backoff+jitter tối đa 5; permanent error vào failed/review.
- Dry-run không mutate; disable không hủy execution đã bắt đầu.
- Automation không được gửi cho archived customer, revoked consent hoặc ngoài provider messaging policy.

### UI/API

Rule builder dạng trigger/condition/action, execution log, dry-run, disable/replay. Không làm canvas node.

### Acceptance

Order fulfilled tạo follow-up task; SLA warning notify Manager; duplicate event không lặp side effect; consent/provider policy chặn outbound; retry/replay có lịch sử.

---

## FEATURE F07 — Omnichannel Inbox Foundation & Website

**Goal:** chứng minh đa kênh trước bằng web form và webchat do ta kiểm soát.  
**Depends on:** F02, F04, F05.

### Model

- ChannelConnection, ChannelIdentity, Conversation, Participant, Message, InboxEvent.
- Conversation status OPEN/PENDING/CLOSED; owner/team/unread/lastMessageAt.
- Message direction INBOUND/OUTBOUND, immutable provider ID, sent/delivered/read/failed status.

### Website capture

- Admin tạo PUBLISHED form với allowed/required fields, source, consent text, assignment/default-ticket policy, allowed origins.
- Public browser dùng opaque form ID, không dùng API key; rate limit, honeypot, payload cap, optional CAPTCHA adapter.
- Lưu UTM/referrer/landingPage/consentAt; submission đi qua Customer resolution của F02.

### Webchat

- Widget/script demo hoặc hosted chat page tạo conversation/channel identity.
- Tin inbound persist trước rồi async xử lý; agent reply từ Inbox.
- Nếu visitor cung cấp email/phone, resolve/link customer; ambiguous → review queue.
- Có thể create ticket từ conversation; reply sau khi ticket resolved có thể reopen theo policy.

### UI/API

Public form page, form settings, inbox split view, conversation/customer side panel, link/merge identity, create ticket.

### Acceptance

Khách gửi form/webchat → Customer 360/timeline/inbox đúng; refresh/retry không duplicate; browser không thấy secret; two-agent concurrent reply/assignment có version conflict an toàn.

---

## FEATURE F08 — Facebook Messenger Connector

**Goal:** đưa Facebook Page messaging vào cùng Inbox/Customer 360 qua adapter chuẩn.  
**Depends on:** F07; F06 cho outbound automation.

### Common connector rules

- Connection lifecycle DISCONNECTED/CONNECTING/ACTIVE/NEEDS_REAUTH/ERROR/DISABLED.
- PLATFORM_MANAGED_APP và BRING_YOUR_OWN_APP theo CORE.
- OAuth state/PKCE nếu provider hỗ trợ, CSRF protection, encrypted token, expiry/refresh/revoke handling.
- Webhook verify → persist unique InboxEvent → acknowledge → worker normalize; poison event vào review queue.
- Mapping `connection + externalUserId` tới ChannelIdentity/Customer; external event/message ID unique.
- Outbound chỉ khi connection active, user có permission và provider policy cho phép.

### Facebook Messenger

- Connect/select Page, subscribe webhook, ingest message/delivery/read events theo capability hiện hành.
- Không assume được tải toàn bộ lịch sử; backfill chỉ mức provider cho phép.

### Acceptance

Sanitized provider fixtures chứng minh duplicate webhook không duplicate message; invalid signature bị reject; token expiry báo Admin; unknown/known/ambiguous identity flows đúng; Messenger xuất hiện cùng webchat/manual activity trên timeline.

---

## FEATURE F09 — POSTPONED: Phase 4 Extensions

**Không triển khai trong kế hoạch hiện tại.** F09 giữ chỗ cho Zalo OA, telephony provider, CSV import, báo cáo nâng cao và các extension khác. Chỉ mở lại bằng một lần product review/plan riêng; agent không được tự làm trước.

---

## Prompt bootstrap duy nhất

```text
MODE=BOOTSTRAP.

Đọc toàn bộ AGENTS.md để hiểu SalesFlow Omnichannel Customer Service CRM, sau đó
chỉ triển khai FEATURE F00 — Project Foundation. Dựng Express API, BullMQ worker,
React/Vite web shell, module boundaries, database/queue/test infrastructure,
Docker Compose và CI. Không implement trước nghiệp vụ F01–F09.

Tuân thủ CORE rules; comment kỹ phần architecture/concurrency/security theo policy;
chạy verification thật và tạo docs/PROJECT_STATE.md cùng module README để agent sau
không cần đọc lại toàn bộ blueprint. Bảo toàn mọi user changes trong repo.

Kết thúc bằng outcome, files, commands/tests, ADR/decisions, risks và next dependency.
```

## Prompt feature sau này

```text
MODE=FEATURE. Implement FEATURE Fxx theo AGENTS.md.

Đọc CORE rules cần thiết, section Fxx, docs/PROJECT_STATE.md và code/contracts/tests
liên quan. Chỉ tra dependency section khi current public contract chưa đủ rõ. Không
đọc lại toàn bộ blueprint hoặc mở rộng scope. Chạy test và cập nhật PROJECT_STATE.
```
