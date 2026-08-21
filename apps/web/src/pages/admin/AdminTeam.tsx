import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MEMBERSHIP_ROLES, ROLE_LABELS, type MembershipRole } from '@nio/shared';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { Loading, Empty, Alert, Field } from '../../components/ui';

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
  status: string;
  createdAt: string;
}

const ROLE_HINTS: Record<MembershipRole, string> = {
  bu_admin: 'Full configuration access for this business unit.',
  patient: 'Normally self-registers from your storefront.',
  fulfillment: 'Receives paid orders, prints kit labels and ships.',
  lab: 'Checks samples in and uploads results.',
  doctor: 'Interprets results before they reach the patient.',
};

export function AdminTeam() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<{ email: string; name: string; role: MembershipRole }>({
    email: '',
    name: '',
    role: 'fulfillment',
  });
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', slug, 'members'],
    queryFn: () => api<{ members: Member[] }>(`/api/bu/${slug}/members`),
  });

  function done(text: string) {
    setIsError(false);
    setMessage(text);
    void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'members'] });
  }
  function fail(err: Error) {
    setIsError(true);
    setMessage(err.message);
  }

  const invite = useMutation({
    mutationFn: () => api(`/api/bu/${slug}/members`, { method: 'POST', body: form }),
    onSuccess: () => {
      done(`${form.email} added as ${ROLE_LABELS[form.role]}.`);
      setForm({ email: '', name: '', role: 'fulfillment' });
    },
    onError: fail,
  });

  const setStatus = useMutation({
    mutationFn: ({ membershipId, status }: { membershipId: string; status: string }) =>
      api(`/api/bu/${slug}/members/${membershipId}/status`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: () => done('Member updated.'),
    onError: fail,
  });

  if (isLoading) return <Loading what="team" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <p>Create the accounts that run each stage of your workflow.</p>
        </div>
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Add a team member</div>
          <Field label="Full name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email address">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Role" hint={ROLE_HINTS[form.role]}>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as MembershipRole })}
            >
              {MEMBERSHIP_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </Field>
          <button
            className="primary"
            onClick={() => invite.mutate()}
            disabled={!form.email || !form.name || invite.isPending}
          >
            Add member
          </button>
        </div>

        <div className="card">
          <div className="card-title">Current roster</div>
          {(data?.members.length ?? 0) === 0 ? (
            <Empty>No members yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Added</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data!.members.map((member) => (
                  <tr key={member.membershipId}>
                    <td>
                      {member.name}
                      <div className="small muted mono">{member.email}</div>
                    </td>
                    <td>{ROLE_LABELS[member.role]}</td>
                    <td className="muted small">{date(member.createdAt)}</td>
                    <td>
                      <select
                        value={member.status}
                        onChange={(event) =>
                          setStatus.mutate({
                            membershipId: member.membershipId,
                            status: event.target.value,
                          })
                        }
                      >
                        <option value="active">Active</option>
                        <option value="suspended">Suspended</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
