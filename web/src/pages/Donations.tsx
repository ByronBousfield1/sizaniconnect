import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, ErrorNotice, Loading, Notice, PageHeader, Pill, Select, Table, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtRand, todaySA } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { StockItem } from '../lib/types';

interface Donor {
  id: string;
  donorName: string;
  donorType: string;
  contactEmail: string | null;
  totalValue: number;
  donationCount: number;
}
interface Donation {
  id: string;
  donationType: 'Cash' | 'InKind';
  monetaryValue: number;
  receivedOn: string;
  receiptNumber: string;
  donorName: string;
  lineCount: number;
}

/** S12: capture donations (SD-03, US-12) */
export function DonationsPage() {
  const { can } = useAuth();
  const donations = useLoad(() => api<Donation[]>('/donations'));
  const [capturing, setCapturing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Donations"
        lede="In-kind donations become stock batches with their own expiry dates, so every parcel can be traced to its donor."
        actions={can('OperationsManager') && !capturing ? <Button onClick={() => {
              setCapturing(true);
              setSaved(null);
            }}>Capture a donation</Button> : null}
      />
      {saved ? (
        <Notice tone="good">
          <p>
            Donation saved under receipt <strong>{saved}</strong>. The donor has been emailed if they have an address on record.
          </p>
        </Notice>
      ) : null}
      {capturing ? (
        <CaptureForm
          onDone={(receipt) => {
            setCapturing(false);
            setSaved(receipt);
            donations.reload();
          }}
          onCancel={() => setCapturing(false)}
        />
      ) : null}

      <ErrorNotice error={donations.error} />
      {donations.loading && !donations.data ? <Loading /> : null}
      {donations.data?.length === 0 ? <Empty title="No donations recorded yet" /> : null}
      {donations.data?.length ? (
        <Table caption="Donations">
          <thead>
            <tr>
              <th>Received</th>
              <th>Receipt</th>
              <th>Donor</th>
              <th>Type</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {donations.data.map((d) => (
              <tr key={d.id}>
                <td className="nowrap">{fmtDate(d.receivedOn)}</td>
                <td className="nowrap">
                  <Link to={`/donations/${d.id}/receipt`}>{d.receiptNumber}</Link>
                </td>
                <td>{d.donorName}</td>
                <td>
                  {d.donationType === 'Cash' ? <Pill tone="info">Cash</Pill> : <Pill tone="neutral">{d.lineCount} stock {d.lineCount === 1 ? 'line' : 'lines'}</Pill>}
                </td>
                <td className="num">{d.monetaryValue ? fmtRand(d.monetaryValue) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}

interface Line {
  stockItemId: string;
  quantity: string;
  expiryDate: string;
}

function CaptureForm({ onDone, onCancel }: { onDone: (receipt: string) => void; onCancel: () => void }) {
  const donors = useLoad(() => api<Donor[]>('/donors'));
  const items = useLoad(() => api<StockItem[]>('/stock/items'));
  const [donorId, setDonorId] = useState('');
  const [newDonor, setNewDonor] = useState({ donorName: '', donorType: 'Individual', contactEmail: '' });
  const [type, setType] = useState<'InKind' | 'Cash'>('InKind');
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(todaySA());
  const [lines, setLines] = useState<Line[]>([{ stockItemId: '', quantity: '', expiryDate: '' }]);
  const { busy, error, run } = useAction();

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run(async () => {
      let id = donorId;
      if (id === 'new') {
        id = (await api<{ id: string }>('/donors', { body: newDonor })).id;
        setDonorId(id);
        donors.reload();
      }
      return api<{ receiptNumber: string }>('/donations', {
        body: {
          donorId: id,
          donationType: type,
          receivedOn,
          monetaryValue: amount ? Number(amount) : undefined,
          lines:
            type === 'InKind'
              ? lines.filter((l) => l.stockItemId).map((l) => ({ stockItemId: l.stockItemId, quantity: Number(l.quantity), expiryDate: l.expiryDate || null }))
              : undefined,
        },
      });
    });
    if (result) onDone(result.receiptNumber);
  };

  return (
    <form className="panel" onSubmit={submit} noValidate>
      <h2>Capture a donation</h2>
      <div className="form-row">
        <Select label="Donor" value={donorId} onChange={(e) => setDonorId(e.target.value)}>
          <option value="">Choose a donor</option>
          {donors.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.donorName}
            </option>
          ))}
          <option value="new">New donor…</option>
        </Select>
        <TextInput label="Received on" type="date" max={todaySA()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
      </div>
      {donorId === 'new' ? (
        <div className="form-row">
          <TextInput label="Donor name" value={newDonor.donorName} onChange={(e) => setNewDonor({ ...newDonor, donorName: e.target.value })} />
          <Select label="Donor type" value={newDonor.donorType} onChange={(e) => setNewDonor({ ...newDonor, donorType: e.target.value })}>
            {['Individual', 'Corporate', 'Trust', 'Government'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
          <TextInput label="Email for receipts" hint="Optional" type="email" value={newDonor.contactEmail} onChange={(e) => setNewDonor({ ...newDonor, contactEmail: e.target.value })} />
        </div>
      ) : null}

      <div className="segmented" role="group" aria-label="Donation type">
        <button type="button" aria-pressed={type === 'InKind'} onClick={() => setType('InKind')}>
          Goods (in kind)
        </button>
        <button type="button" aria-pressed={type === 'Cash'} onClick={() => setType('Cash')}>
          Money
        </button>
      </div>

      {type === 'Cash' ? (
        <TextInput label="Amount (rand)" type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      ) : (
        <>
          {lines.map((l, i) => (
            <div className="form-row" key={i}>
              <Select label={`Item ${i + 1}`} value={l.stockItemId} onChange={(e) => setLine(i, { stockItemId: e.target.value })}>
                <option value="">Choose an item</option>
                {items.data?.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.itemName}
                  </option>
                ))}
              </Select>
              <TextInput label="Quantity" type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
              <TextInput label="Best before" hint="Leave empty if none" type="date" min={receivedOn} value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />
            </div>
          ))}
          <Button kind="quiet" onClick={() => setLines([...lines, { stockItemId: '', quantity: '', expiryDate: '' }])}>
            Add another item
          </Button>
          <TextInput label="Estimated value (rand)" hint="Optional, for impact reporting" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} className="field-spaced" />
        </>
      )}

      <ErrorNotice error={error} />
      <div className="form-actions">
        <Button type="submit" busy={busy}>
          Save donation
        </Button>
        <Button kind="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
