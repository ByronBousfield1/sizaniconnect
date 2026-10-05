import { Link, useParams } from 'react-router-dom';
import { Button, Empty, ErrorNotice, Loading, PageHeader, Stat, Table } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtQty, fmtRand } from '../lib/format';
import { useLoad } from '../lib/hooks';

interface Impact {
  cashGiven: number;
  donationCount: number;
  firstGift: string | null;
  parcelsContributedTo: number;
  householdsReached: number;
  sitesReached: number;
  items: { itemName: string; unitOfMeasure: string; received: number; distributed: number }[];
  donations: { id: string; donationType: string; monetaryValue: number; receivedOn: string; receiptNumber: string }[];
}

/** S17 portal and S18 impact report (US-16) */
export function DonorPortalPage() {
  const { user } = useAuth();
  const { data, error, loading } = useLoad(() => api<Impact>('/me/impact'));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="What your giving made possible"
        lede={data.firstGift ? `${user?.fullName}, supporting Sizani since ${fmtDate(data.firstGift)}.` : undefined}
        actions={<Button kind="quiet" onClick={() => window.print()}>Print this report</Button>}
      />
      <div className="stats">
        <Stat value={data.householdsReached} label="Households who received your food" tone="good" />
        <Stat value={data.parcelsContributedTo} label="Parcels your stock went into" />
        <Stat value={data.sitesReached} label="Distribution sites reached" />
        <Stat value={fmtRand(data.cashGiven)} label="Cash given" />
      </div>
      <div className="grid-2">
        <section className="panel">
          <h2>Your goods, traced to distribution</h2>
          {data.items.length === 0 ? (
            <p className="muted">Your in-kind donations will appear here once received.</p>
          ) : (
            <Table caption="Goods donated and distributed">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Given</th>
                  <th className="num">Distributed</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.itemName}>
                    <td>{i.itemName}</td>
                    <td className="num">
                      {fmtQty(i.received)} {i.unitOfMeasure}
                    </td>
                    <td className="num">{fmtQty(i.distributed)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
        <section className="panel">
          <h2>Your donations</h2>
          {data.donations.length === 0 ? (
            <Empty title="No donations yet" />
          ) : (
            <ul className="list-plain">
              {data.donations.map((d) => (
                <li key={d.id} className="row-between">
                  <span>
                    {fmtDate(d.receivedOn)}{' '}
                    <span className="small muted">{d.donationType === 'Cash' ? fmtRand(d.monetaryValue) : 'Goods'}</span>
                  </span>
                  <Link to={`/donations/${d.id}/receipt`}>Receipt {d.receiptNumber}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

interface DonationDetail {
  id: string;
  donationType: 'Cash' | 'InKind';
  monetaryValue: number;
  receivedOn: string;
  receiptNumber: string;
  donorName: string;
  donorType: string;
  notes: string | null;
  lines: { itemName: string; unitOfMeasure: string; quantity: number; expiryDate: string | null }[];
}

/** S19: a printable receipt (US-17). Donors can open only their own. */
export function ReceiptPage() {
  const { id = '' } = useParams();
  const { data: d, error, loading } = useLoad(() => api<DonationDetail>(`/donations/${id}`), [id]);
  if (loading && !d) return <Loading />;
  if (error) return <ErrorNotice error={error} />;
  if (!d) return null;
  return (
    <>
      <PageHeader title={`Receipt ${d.receiptNumber}`} actions={<Button onClick={() => window.print()}>Print or save as PDF</Button>} />
      <section className="panel" style={{ maxWidth: '40rem' }}>
        <p>
          <strong>Sizani Community Food Network NPC</strong>
          <br />
          <span className="muted">Johannesburg</span>
        </p>
        <dl className="def-list">
          <dt>Receipt number</dt>
          <dd>{d.receiptNumber}</dd>
          <dt>Received from</dt>
          <dd>{d.donorName}</dd>
          <dt>Date received</dt>
          <dd>{fmtDate(d.receivedOn)}</dd>
          <dt>Type</dt>
          <dd>{d.donationType === 'Cash' ? 'Monetary donation' : 'Donation in kind'}</dd>
          {d.monetaryValue ? (
            <>
              <dt>{d.donationType === 'Cash' ? 'Amount' : 'Estimated value'}</dt>
              <dd>{fmtRand(d.monetaryValue)}</dd>
            </>
          ) : null}
        </dl>
        {d.lines.length ? (
          <>
            <h3 style={{ marginTop: 'var(--s-5)' }}>Goods received</h3>
            <ul className="issued-list">
              {d.lines.map((l) => (
                <li key={l.itemName}>
                  {fmtQty(l.quantity)} {l.unitOfMeasure} {l.itemName}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="small muted" style={{ marginTop: 'var(--s-5)' }}>
          Receipt reference for Section 18A purposes. The organisation&rsquo;s Section 18A approval number must appear on the final tax certificate.
        </p>
      </section>
    </>
  );
}
