import { Fragment, useState, type FormEvent } from 'react';
import { Button, Dialog, ErrorNotice, Loading, Notice, PageHeader, Pill, Table, TextArea, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtQty } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { StockItem } from '../lib/types';

interface AlertBatch {
  batchId: string;
  itemName: string;
  unitOfMeasure: string;
  quantityRemaining: number;
  expiryDate: string;
  expired: boolean;
}
interface Alerts {
  lowStock: StockItem[];
  expiring: AlertBatch[];
  expired: AlertBatch[];
}
interface Batch {
  id: string;
  quantityReceived: number;
  quantityRemaining: number;
  expiryDate: string | null;
  receivedOn: string;
  receiptNumber: string | null;
  donorName: string | null;
}
interface ParcelLine {
  parcelSize: string;
  itemName: string;
  unitOfMeasure: string;
  quantity: number;
}

/** S11: stock on hand, batches, alerts (US-13, US-14) */
export function StockPage() {
  const { can } = useAuth();
  const isOps = can('OperationsManager');
  const items = useLoad(() => api<StockItem[]>('/stock/items'));
  const alerts = useLoad(() => api<Alerts>('/stock/alerts'));
  const parcels = useLoad(() => api<ParcelLine[]>('/parcels'));
  const [open, setOpen] = useState<string | null>(null);
  const batches = useLoad(() => (open ? api<{ batches: Batch[] }>(`/stock/items/${open}/batches`) : Promise.resolve(null)), [open]);
  const [writeOff, setWriteOff] = useState<AlertBatch | null>(null);
  const [reason, setReason] = useState('Expired, removed from shelf');
  const [adding, setAdding] = useState(false);
  const action = useAction();

  const confirmWriteOff = async () => {
    if (!writeOff) return;
    const ok = await action.run(() => api(`/stock/batches/${writeOff.batchId}/write-off`, { body: { reason } }));
    if (ok) {
      setWriteOff(null);
      items.reload();
      alerts.reload();
    }
  };

  const totalAlerts = (alerts.data?.lowStock.length ?? 0) + (alerts.data?.expiring.length ?? 0) + (alerts.data?.expired.length ?? 0);

  return (
    <>
      <PageHeader
        title="Stock"
        lede="On hand counts only stock that can still be issued. Parcels draw from the batch that expires first."
        actions={isOps ? <Button onClick={() => setAdding(true)}>Add a stock item</Button> : null}
      />
      {adding ? <NewItemForm onDone={() => {
            setAdding(false);
            items.reload();
          }} onCancel={() => setAdding(false)} /> : null}

      {alerts.data && totalAlerts > 0 ? (
        <section className="panel" aria-labelledby="alerts-h">
          <h2 id="alerts-h">Needs action</h2>
          <ul className="list-plain">
            {alerts.data.expired.map((b) => (
              <li key={b.batchId} className="row-between">
                <span>
                  <Pill tone="bad">Expired</Pill> {fmtQty(b.quantityRemaining)} {b.unitOfMeasure} {b.itemName}, expired {fmtDate(b.expiryDate)}
                </span>
                {isOps ? (
                  <Button kind="danger" className="btn-small" onClick={() => setWriteOff(b)}>
                    Write off
                  </Button>
                ) : null}
              </li>
            ))}
            {alerts.data.expiring.map((b) => (
              <li key={b.batchId}>
                <Pill tone="warn">Expires soon</Pill> {fmtQty(b.quantityRemaining)} {b.unitOfMeasure} {b.itemName} by {fmtDate(b.expiryDate)}. Issue these first.
              </li>
            ))}
            {alerts.data.lowStock.map((i) => (
              <li key={i.id}>
                <Pill tone="warn">Low</Pill> {i.itemName}: {fmtQty(i.onHand)} {i.unitOfMeasure} left, reorder level {fmtQty(i.reorderLevel)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ErrorNotice error={items.error} />
      {items.loading && !items.data ? <Loading /> : null}
      {items.data ? (
        <Table caption="Stock items">
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th className="num">On hand</th>
              <th className="num">Reorder at</th>
              <th>Next expiry</th>
              <th>
                <span className="sr-only">Batches</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.data.map((i) => (
              <Fragment key={i.id}>
                <tr>
                  <td>
                    <strong>{i.itemName}</strong> {i.belowReorder ? <Pill tone="warn">Low</Pill> : null}
                  </td>
                  <td>{i.category}</td>
                  <td className="num">
                    {fmtQty(i.onHand)} {i.unitOfMeasure}
                  </td>
                  <td className="num">{fmtQty(i.reorderLevel)}</td>
                  <td className="nowrap">{fmtDate(i.nextExpiry)}</td>
                  <td>
                    <Button kind="quiet" className="btn-small" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>
                      {open === i.id ? 'Hide batches' : 'Batches'}
                    </Button>
                  </td>
                </tr>
                {open === i.id ? (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--paper)' }}>
                      {batches.loading ? (
                        <Loading />
                      ) : (
                        <Table caption={`Batches of ${i.itemName}`}>
                          <thead>
                            <tr>
                              <th>Received</th>
                              <th>From</th>
                              <th className="num">Remaining</th>
                              <th>Expires</th>
                            </tr>
                          </thead>
                          <tbody>
                            {batches.data?.batches.map((b) => (
                              <tr key={b.id}>
                                <td className="nowrap">{fmtDate(b.receivedOn)}</td>
                                <td>{b.donorName ? `${b.donorName} (${b.receiptNumber})` : 'Purchased'}</td>
                                <td className="num">
                                  {fmtQty(b.quantityRemaining)} of {fmtQty(b.quantityReceived)}
                                </td>
                                <td className="nowrap">{fmtDate(b.expiryDate)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </Table>
      ) : null}

      {parcels.data ? (
        <section className="panel" style={{ marginTop: 'var(--s-5)' }}>
          <h2>What goes in a parcel</h2>
          <div className="grid-2">
            {['Small', 'Medium', 'Large'].map((size) => (
              <div key={size}>
                <h3>
                  {size} <span className="muted small">({size === 'Small' ? '1 to 2' : size === 'Medium' ? '3 to 5' : '6 or more'} people)</span>
                </h3>
                <ul className="issued-list">
                  {parcels.data!.filter((p) => p.parcelSize === size).map((p) => (
                    <li key={p.itemName}>
                      {fmtQty(p.quantity)} {p.unitOfMeasure} {p.itemName}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Dialog open={!!writeOff} title="Write off expired stock" onClose={() => setWriteOff(null)}>
        {writeOff ? (
          <Notice tone="warn">
            <p>
              {fmtQty(writeOff.quantityRemaining)} {writeOff.unitOfMeasure} {writeOff.itemName} will be removed from stock. This is recorded in the stock ledger.
            </p>
          </Notice>
        ) : null}
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorNotice error={action.error} />
        <div className="form-actions">
          <Button kind="danger" busy={action.busy} onClick={() => void confirmWriteOff()}>
            Write off
          </Button>
          <Button kind="quiet" onClick={() => setWriteOff(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function NewItemForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ itemName: '', category: 'Staples', unitOfMeasure: '', reorderLevel: '0' });
  const { busy, error, run } = useAction();
  const fe = error?.fieldErrors ?? {};
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api('/stock/items', { body: { ...form, reorderLevel: Number(form.reorderLevel) } }));
    if (ok) onDone();
  };
  return (
    <form className="panel" onSubmit={submit} noValidate>
      <h2>Add a stock item</h2>
      <ErrorNotice error={error} />
      <div className="form-row">
        <TextInput label="Item name" hint="Include the pack size, e.g. Samp 5 kg" value={form.itemName} onChange={(e) => setForm({ ...form, itemName: e.target.value })} error={fe.itemName} />
        <TextInput label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} error={fe.category} />
        <TextInput label="Unit" hint="bag, tin, bottle…" value={form.unitOfMeasure} onChange={(e) => setForm({ ...form, unitOfMeasure: e.target.value })} error={fe.unitOfMeasure} />
        <TextInput label="Reorder level" type="number" min={0} value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} error={fe.reorderLevel} />
      </div>
      <div className="form-actions">
        <Button type="submit" busy={busy}>
          Add item
        </Button>
        <Button kind="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
