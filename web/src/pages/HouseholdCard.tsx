import { Link, useParams } from 'react-router-dom';
import { QrCode } from '../components/QrCode';
import { Button, ErrorNotice, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { cardPayload } from '../lib/scan';
import type { HouseholdDetail } from '../lib/types';

/**
 * S5b: the household card (US-09). Bank-card size, printed in black on white so it photocopies,
 * with the reference code in large type under the QR code so it can always be typed instead.
 */
export function HouseholdCardPage() {
  const { id } = useParams();
  const { data: h, error, loading } = useLoad(() => api<HouseholdDetail>(`/households/${id}`), [id]);
  if (loading && !h) return <Loading />;
  if (error) return <ErrorNotice error={error} />;
  if (!h) return null;

  if (h.status === 'Archived' || h.status === 'Suspended') {
    return (
      <>
        <PageHeader title="Household card" />
        <Notice tone="warn">
          <p>Cards are printed only for households that can collect. This household is {h.status.toLowerCase()}.</p>
        </Notice>
        <Link to={`/households/${h.id}`}>Back to the household</Link>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Household card"
        lede="Print on card or thick paper and cut along the border. The household brings it to every distribution day."
        actions={
          <>
            <Button onClick={() => window.print()}>Print card</Button>
            <Link className="btn btn-quiet" to={`/households/${h.id}`}>
              Back to the household
            </Link>
          </>
        }
      />
      <article className="household-card" aria-label={`Household card for ${h.headOfHousehold}`}>
        <div className="household-card-text">
          <p className="household-card-brand">Sizani Community Food Network</p>
          <p className="household-card-name">{h.headOfHousehold}</p>
          <p className="household-card-site">Collects at {h.homeSiteName}</p>
          <p className="household-card-code">{h.referenceCode}</p>
          <p className="household-card-note">Bring this card every time. Lost it? Ask your site coordinator for a new one.</p>
        </div>
        <QrCode value={cardPayload(h.referenceCode)} size={150} label={`QR code for ${h.referenceCode}`} />
      </article>
    </>
  );
}
