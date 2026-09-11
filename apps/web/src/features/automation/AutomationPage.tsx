import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
  role: string;
}
interface Rule {
  id: string;
  name: string;
  trigger: string;
  active: boolean;
  currentVersion: number;
  version: number;
}
interface ExecutionAction {
  id: string;
  actionType: string;
  status: string;
  errorCode: string | null;
}
interface Execution {
  id: string;
  ruleId: string;
  status: string;
  errorCode: string | null;
  startedAt: string;
  actions: ExecutionAction[];
}

const triggers = [
  'CUSTOMER_CREATED',
  'CUSTOMER_TAGGED',
  'ORDER_CONFIRMED',
  'ORDER_FULFILLED',
  'TICKET_CREATED',
  'TICKET_STATUS_CHANGED',
  'SLA_WARNING',
  'SLA_BREACHED',
  'TASK_OVERDUE',
  'CUSTOMER_BIRTHDAY',
] as const;

export function AutomationPage() {
  const [message, setMessage] = useState('');
  const [actionType, setActionType] = useState('CREATE_TASK');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const rules = useQuery({
    queryKey: ['automations', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Rule[] }>(`/workspaces/${workspace?.id}/automations`),
  });
  const executions = useQuery({
    queryKey: ['automation-executions', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () =>
      apiRequest<{ data: Execution[] }>(
        `/workspaces/${workspace?.id}/automation-executions?limit=50`,
      ),
  });
  const canConfigure = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';

  async function createRule(formData: FormData) {
    if (!workspace) return;
    const text = String(formData.get('actionText') ?? '').trim();
    const action =
      actionType === 'CREATE_TASK'
        ? { type: actionType, title: text, dueInMinutes: Number(formData.get('dueInMinutes')) }
        : actionType === 'NOTIFY_IN_APP'
          ? { type: actionType, message: text, roles: ['CS_MANAGER', 'OWNER'] }
          : { type: actionType, tag: text };
    try {
      await apiRequest(`/workspaces/${workspace.id}/automations`, {
        method: 'POST',
        body: JSON.stringify({
          name: formData.get('name'),
          trigger: formData.get('trigger'),
          conditionMode: 'ALL',
          conditions: [],
          actions: [action],
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['automations', workspace.id] });
      setMessage('Đã tạo rule ở trạng thái tắt để bạn kiểm tra trước khi bật.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể tạo automation');
    }
  }

  async function toggle(rule: Rule) {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/automations/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: rule.version, active: !rule.active }),
      });
      await queryClient.invalidateQueries({ queryKey: ['automations', workspace.id] });
      setMessage(rule.active ? 'Đã tắt rule; execution đang chạy không bị hủy.' : 'Đã bật rule.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể đổi trạng thái rule');
    }
  }

  async function dryRun(formData: FormData) {
    if (!workspace) return;
    const ruleId = String(formData.get('ruleId'));
    const aggregateId = String(formData.get('aggregateId'));
    try {
      const result = await apiRequest<{ data: { matched: boolean; actions: object[] } }>(
        `/workspaces/${workspace.id}/automations/${ruleId}/dry-run`,
        {
          method: 'POST',
          body: JSON.stringify({
            eventType: formData.get('eventType'),
            aggregateType: formData.get('aggregateType'),
            aggregateId,
            payload: {},
          }),
        },
      );
      setMessage(
        result.data.matched
          ? `Khớp; sẽ chạy ${result.data.actions.length} action, chưa mutate dữ liệu.`
          : 'Không khớp điều kiện; chưa mutate dữ liệu.',
      );
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Dry-run thất bại');
    }
  }

  async function replay(executionId: string) {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/automation-executions/${executionId}/replay`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Manual replay from execution log' }),
      });
      setMessage('Đã xếp replay vào outbox; lịch sử cũ được giữ nguyên.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể replay');
    }
  }

  if (!workspace)
    return (
      <section>
        <p className="eyebrow">Automation</p>
        <h1>Chưa có workspace.</h1>
      </section>
    );
  return (
    <section>
      <p className="eyebrow">{workspace.name} · WHEN / IF / THEN</p>
      <h1>Chăm sóc chủ động.</h1>
      <div className="automation-grid">
        <div>
          <h2>Rules</h2>
          <div className="automation-list">
            {rules.data?.data.map((rule) => (
              <article key={rule.id}>
                <span>
                  {rule.trigger} · v{rule.currentVersion}
                </span>
                <h3>{rule.name}</h3>
                <p>{rule.active ? 'Đang chạy' : 'Đang tắt'}</p>
                {canConfigure && (
                  <button type="button" onClick={() => void toggle(rule)}>
                    {rule.active ? 'Tắt' : 'Bật'}
                  </button>
                )}
              </article>
            ))}
            {!rules.isLoading && !rules.data?.data.length && <p>Chưa có automation rule.</p>}
          </div>
          <h2>Execution log</h2>
          <div className="execution-list">
            {executions.data?.data.map((execution) => (
              <article key={execution.id}>
                <span>{new Date(execution.startedAt).toLocaleString('vi-VN')}</span>
                <strong>
                  {execution.status}
                  {execution.errorCode ? ` · ${execution.errorCode}` : ''}
                </strong>
                <small>
                  {execution.actions
                    .map((action) => `${action.actionType}: ${action.status}`)
                    .join(' → ') || 'Không có action'}
                </small>
                {canConfigure && execution.status === 'FAILED' && (
                  <button type="button" onClick={() => void replay(execution.id)}>
                    Replay
                  </button>
                )}
              </article>
            ))}
          </div>
        </div>
        {canConfigure && (
          <div>
            <form className="settings-form" action={createRule}>
              <h2>Tạo rule</h2>
              <label>
                Tên
                <input name="name" required />
              </label>
              <label>
                WHEN
                <select name="trigger">
                  {triggers.map((trigger) => (
                    <option key={trigger}>{trigger}</option>
                  ))}
                </select>
              </label>
              <label>
                THEN
                <select value={actionType} onChange={(event) => setActionType(event.target.value)}>
                  <option>CREATE_TASK</option>
                  <option>NOTIFY_IN_APP</option>
                  <option>ADD_TAG</option>
                  <option>REMOVE_TAG</option>
                </select>
              </label>
              <label>
                {actionType === 'CREATE_TASK'
                  ? 'Tên task'
                  : actionType === 'NOTIFY_IN_APP'
                    ? 'Nội dung thông báo'
                    : 'Tag'}
                <input name="actionText" required />
              </label>
              {actionType === 'CREATE_TASK' && (
                <label>
                  Hạn sau (phút)
                  <input name="dueInMinutes" type="number" min="0" defaultValue="1440" required />
                </label>
              )}
              <button type="submit">Tạo rule</button>
            </form>
            <form className="settings-form" action={dryRun}>
              <h2>Dry-run</h2>
              <label>
                Rule
                <select name="ruleId" required>
                  <option value="">Chọn rule</option>
                  {rules.data?.data.map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Event
                <input name="eventType" defaultValue="order.status_changed" required />
              </label>
              <label>
                Aggregate
                <select name="aggregateType">
                  <option>order</option>
                  <option>customer</option>
                  <option>ticket</option>
                </select>
              </label>
              <label>
                Aggregate UUID
                <input name="aggregateId" required />
              </label>
              <button type="submit">Chạy thử, không mutate</button>
            </form>
          </div>
        )}
      </div>
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
    </section>
  );
}
