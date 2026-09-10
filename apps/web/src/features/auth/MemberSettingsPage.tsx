import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { apiRequest, ApiClientError } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
  role: string;
}

interface Member {
  id: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  availability: string;
}

interface Team {
  id: string;
  name: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

export function MemberSettingsPage() {
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const members = useQuery({
    queryKey: ['members', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Member[] }>(`/workspaces/${workspace?.id}/members`),
  });
  const teams = useQuery({
    queryKey: ['teams', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Team[] }>(`/workspaces/${workspace?.id}/teams`),
  });
  const canManage = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
  const invitations = useQuery({
    queryKey: ['invitations', workspace?.id],
    enabled: Boolean(workspace && canManage),
    queryFn: () => apiRequest<{ data: Invitation[] }>(`/workspaces/${workspace?.id}/invitations`),
  });

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể cập nhật cài đặt');
    }
  }

  async function invite(formData: FormData) {
    if (!workspace) return;
    setMessage('');
    try {
      const result = await apiRequest<{ data: { token?: string } }>(
        `/workspaces/${workspace.id}/invitations`,
        {
          method: 'POST',
          body: JSON.stringify({ email: formData.get('email'), role: formData.get('role') }),
        },
      );
      setMessage(
        result.data.token
          ? `Link local: /accept-invitation?token=${result.data.token}`
          : 'Đã gửi lời mời.',
      );
      await queryClient.invalidateQueries({ queryKey: ['invitations', workspace.id] });
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể tạo lời mời');
    }
  }

  async function revokeInvitation(formData: FormData) {
    if (!workspace) return;
    const invitationId = String(formData.get('invitationId'));
    await run(async () => {
      await apiRequest(`/workspaces/${workspace.id}/invitations/${invitationId}`, {
        method: 'DELETE',
      });
      await queryClient.invalidateQueries({ queryKey: ['invitations', workspace.id] });
    }, 'Đã thu hồi lời mời.');
  }

  async function updateMember(formData: FormData) {
    if (!workspace) return;
    const membershipId = String(formData.get('membershipId'));
    await run(async () => {
      await apiRequest(`/workspaces/${workspace.id}/members/${membershipId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          role: formData.get('role'),
          status: formData.get('status'),
          availability: formData.get('availability'),
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['members', workspace.id] });
    }, 'Đã cập nhật thành viên.');
  }

  async function createTeam(formData: FormData) {
    if (!workspace) return;
    await run(async () => {
      await apiRequest(`/workspaces/${workspace.id}/teams`, {
        method: 'POST',
        body: JSON.stringify({ name: formData.get('name') }),
      });
      await queryClient.invalidateQueries({ queryKey: ['teams', workspace.id] });
    }, 'Đã tạo team.');
  }

  async function addTeamMember(formData: FormData) {
    if (!workspace) return;
    const teamId = String(formData.get('teamId'));
    await run(
      () =>
        apiRequest(`/workspaces/${workspace.id}/teams/${teamId}/members`, {
          method: 'PUT',
          body: JSON.stringify({ membershipId: formData.get('membershipId') }),
        }),
      'Đã thêm thành viên vào team.',
    );
  }

  async function transferOwnership(formData: FormData) {
    if (!workspace) return;
    await run(async () => {
      await apiRequest(`/workspaces/${workspace.id}/transfer-ownership`, {
        method: 'POST',
        body: JSON.stringify({ membershipId: formData.get('membershipId') }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['members', workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
      ]);
    }, 'Đã chuyển quyền sở hữu.');
  }

  if (!workspace) {
    return (
      <section>
        <p className="eyebrow">Cài đặt</p>
        <h1>Chưa có workspace.</h1>
        <Link to="/onboarding">Tạo workspace</Link>
      </section>
    );
  }

  const assignableMembers = members.data?.data.filter((member) => member.status === 'ACTIVE') ?? [];

  return (
    <section>
      <p className="eyebrow">
        {workspace.name} · {workspace.role}
      </p>
      <h1>Thành viên & team.</h1>
      <div className="settings-grid">
        <article>
          <h2>Thành viên</h2>
          <div className="member-list">
            {members.data?.data.map((member) => (
              <div key={member.id}>
                <span className={`status-dot ${member.status.toLowerCase()}`} />
                <p>
                  <strong>{member.displayName}</strong>
                  <small>{member.email}</small>
                </p>
                {canManage && member.role !== 'OWNER' ? (
                  <form className="member-controls" action={updateMember}>
                    <input type="hidden" name="membershipId" value={member.id} />
                    <select name="role" defaultValue={member.role} aria-label="Vai trò">
                      <option>ADMIN</option>
                      <option>CS_MANAGER</option>
                      <option>AGENT</option>
                      <option>SALES</option>
                      <option>VIEWER</option>
                    </select>
                    <select name="status" defaultValue={member.status} aria-label="Trạng thái">
                      <option>ACTIVE</option>
                      <option>DEACTIVATED</option>
                    </select>
                    <select
                      name="availability"
                      defaultValue={member.availability}
                      aria-label="Sẵn sàng nhận việc"
                    >
                      <option>AVAILABLE</option>
                      <option>UNAVAILABLE</option>
                    </select>
                    <button type="submit">Lưu</button>
                  </form>
                ) : (
                  <span>
                    {member.role} · {member.availability}
                  </span>
                )}
              </div>
            ))}
          </div>
          <h2>Teams</h2>
          <div className="team-list">
            {teams.data?.data.map((team) => (
              <span key={team.id}>{team.name}</span>
            ))}
          </div>
        </article>
        {canManage && (
          <div>
            <form className="settings-form" action={invite}>
              <h2>Mời thành viên</h2>
              <label>
                Email
                <input name="email" type="email" required />
              </label>
              <label>
                Vai trò
                <select name="role" defaultValue="AGENT">
                  <option>ADMIN</option>
                  <option>CS_MANAGER</option>
                  <option>AGENT</option>
                  <option>SALES</option>
                  <option>VIEWER</option>
                </select>
              </label>
              <button type="submit">Tạo lời mời</button>
            </form>
            {invitations.data?.data.length ? (
              <div className="settings-form invitation-list">
                <h2>Lời mời đang chờ</h2>
                {invitations.data.data.map((invitation) => (
                  <form key={invitation.id} action={revokeInvitation}>
                    <input type="hidden" name="invitationId" value={invitation.id} />
                    <span>
                      <strong>{invitation.email}</strong>
                      <small>{invitation.role}</small>
                    </span>
                    <button type="submit">Thu hồi</button>
                  </form>
                ))}
              </div>
            ) : null}
            <form className="settings-form" action={createTeam}>
              <h2>Tạo team</h2>
              <label>
                Tên team
                <input name="name" required minLength={2} />
              </label>
              <button type="submit">Tạo team</button>
            </form>
            {teams.data?.data.length && assignableMembers.length ? (
              <form className="settings-form" action={addTeamMember}>
                <h2>Thêm vào team</h2>
                <label>
                  Team
                  <select name="teamId">
                    {teams.data.data.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Thành viên
                  <select name="membershipId">
                    {assignableMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit">Thêm thành viên</button>
              </form>
            ) : null}
            {workspace.role === 'OWNER' &&
              assignableMembers.some((member) => member.role !== 'OWNER') && (
                <form className="settings-form" action={transferOwnership}>
                  <h2>Chuyển quyền sở hữu</h2>
                  <label>
                    Owner mới
                    <select name="membershipId">
                      {assignableMembers
                        .filter((member) => member.role !== 'OWNER')
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button type="submit">Chuyển quyền</button>
                </form>
              )}
            {message && (
              <p role="status" className="settings-message">
                {message}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
