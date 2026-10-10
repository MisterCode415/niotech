import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MEMBERSHIP_ROLES, ROLE_LABELS, type MembershipRole } from '@nio/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useWorkspace } from '../../lib/workspace';
import { date } from '../../lib/format';
import { Loading, Empty, Alert, Field } from '../../components/ui';

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
  status: 'active' | 'suspended';
  userStatus: string;
  lastSignInAt: string | null;
  isMock: boolean;
  createdAt: string;
}

interface Person {
  userId: string;
  email: string;
  name: string;
  lastSignInAt: string | null;
  isMock: boolean;
  roles: MemberRow[];
}

const ROLE_HINTS: Record<MembershipRole, string> = {
  bu_admin: 'Configures packages, payments, the storefront and this team.',
  patient: 'Buys tests and sees results. Normally self-registers from your storefront.',
  fulfillment: 'Receives paid orders, prints kit labels and ships.',
  lab: 'Checks samples in, processes them and uploads results.',
  doctor: 'Interprets results before they are released to the patient.',
};

function groupByPerson(rows: MemberRow[]): Person[] {
  const people = new Map<string, Person>();
  for (const row of rows) {
    const person = people.get(row.userId) ?? {
      userId: row.userId,
      email: row.email,
      name: row.name,
      lastSignInAt: row.lastSignInAt,
      isMock: row.isMock,
      roles: [],
    };
    person.roles.push(row);
    people.set(row.userId, person);
  }
  return [...people.values()].sort((a, b) => Number(a.isMock) - Number(b.isMock));
}

export function AdminTeam() {
  const { slug = '' } = useParams();
  const { me } = useAuth();
  const workspace = useWorkspace(me);
  const queryClient = useQueryClient();

  const [form, setForm] = useState<{ email: string; name: string; role: MembershipRole }>({
    email: '',
    name: '',
    role: 'fulfillment',
  });
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [showMock, setShowMock] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', slug, 'members'],
    queryFn: () =>
      api<{ members: MemberRow[]; signInPath: string }>(`/api/bu/${slug}/members`),
  });

  function done(text: string) {
    setIsError(false);
    setMessage(text);
    void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'members'] });
  }
  function fail(err: Error) {
    setIsError(true);
    setMessage(err.message);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const invite = useMutation({
    mutationFn: () => api(`/api/bu/${slug}/members`, { method: 'POST', body: form }),
    onSuccess: () => {
      done(`${form.email} now holds the ${ROLE_LABELS[form.role]} role.`);
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
    onSuccess: () => done('Access updated.'),
    onError: fail,
  });

  const resend = useMutation({
    mutationFn: (membershipId: string) =>
      api<{ sent: boolean; reason?: string; includesPasswordLink?: boolean }>(
        `/api/bu/${slug}/members/${membershipId}/resend`,
        { method: 'POST' },
      ),
    onSuccess: (result) =>
      result.sent
        ? done(
            result.includesPasswordLink
              ? 'Invitation re-sent with a fresh link to set a password.'
              : 'Sign-in reminder sent. This person has already set a password.',
          )
        : done(result.reason ?? 'Nothing to send.'),
    onError: fail,
  });

  if (isLoading) return <Loading what="team" />;

  const people = groupByPerson(data?.members ?? []);
  const mockCount = people.filter((person) => person.isMock).length;
  const visible = showMock ? people : people.filter((person) => !person.isMock);
  const signInUrl = `${window.location.origin}${data?.signInPath ?? '/login'}`;

  function grantRoleTo(person: Person) {
    setForm({ email: person.email, name: person.name, role: form.role });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Team · {workspace?.businessUnitName ?? slug}</h1>
          <p>
            Everyone who works in this business unit, one row per person. A person can hold several
            roles here (for example Lab and Doctor) and switches between them from the Workspace
            menu at the top. Their sign-in link is{' '}
            <span className="mono small">{signInUrl}</span>.
          </p>
        </div>
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">Add a person or grant a role</div>
          <p className="small muted">
            New people get an email with a link to set their password. Granting a role to someone
            who already has an account adds the role without a new password.
          </p>
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
            {invite.isPending ? 'Saving…' : 'Add or grant role'}
          </button>
        </div>

        <div className="card">
          <div className="spread">
            <div className="card-title">People ({visible.length})</div>
            {mockCount > 0 ? (
              <label className="small muted">
                <input
                  type="checkbox"
                  checked={showMock}
                  onChange={(event) => setShowMock(event.target.checked)}
                />{' '}
                Show {mockCount} mock patient{mockCount === 1 ? '' : 's'}
              </label>
            ) : null}
          </div>
          {visible.length === 0 ? (
            <Empty>No one yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Roles and access</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((person) => (
                  <tr key={person.userId}>
                    <td>
                      {person.name}{' '}
                      {person.isMock ? <span className="badge mock">Mock</span> : null}
                      <div className="small muted mono">{person.email}</div>
                      <div className="small" style={{ marginTop: 4 }}>
                        {person.isMock ? null : person.lastSignInAt ? (
                          <span className="muted">Last signed in {date(person.lastSignInAt)}</span>
                        ) : (
                          <span className="badge pending">Invite pending · never signed in</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="role-chips">
                        {person.roles.map((membership) => (
                          <span
                            key={membership.membershipId}
                            className={`role-chip ${membership.status}`}
                            title={`Added ${date(membership.createdAt)}`}
                          >
                            {ROLE_LABELS[membership.role]}
                            <select
                              aria-label={`${ROLE_LABELS[membership.role]} access`}
                              value={membership.status}
                              onChange={(event) =>
                                setStatus.mutate({
                                  membershipId: membership.membershipId,
                                  status: event.target.value,
                                })
                              }
                            >
                              <option value="active">Active</option>
                              <option value="suspended">Suspended</option>
                            </select>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {person.isMock ? null : (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="small" onClick={() => grantRoleTo(person)}>
                            Grant role
                          </button>
                          <button
                            className="small"
                            disabled={resend.isPending}
                            onClick={() => resend.mutate(person.roles[0]!.membershipId)}
                          >
                            {person.lastSignInAt ? 'Send sign-in link' : 'Resend invite'}
                          </button>
                        </div>
                      )}
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
