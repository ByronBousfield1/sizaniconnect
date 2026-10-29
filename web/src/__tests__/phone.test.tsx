import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CellphoneInput } from '../components/CellphoneInput';
import { fmtPhone } from '../lib/format';
import { parseSaCellphone } from '../lib/phone';

describe('cellphone rule in the browser (mirrors the API)', () => {
  it.each([
    ['082 555 0134', '+27825550134'],
    ['+27 82 555 0134', '+27825550134'],
    ['27711234567', '+27711234567'],
  ])('accepts %s', (raw, e164) => expect(parseSaCellphone(raw)).toEqual({ ok: true, e164 }));

  it.each(['011 555 0134', '0800 123 456', '082 555', 'call me'])('refuses %s', (raw) => expect(parseSaCellphone(raw).ok).toBe(false));

  it('formats the stored form for people to read', () => {
    expect(fmtPhone('+27825550134')).toBe('082 555 0134');
    expect(fmtPhone(null)).toBe('—');
  });

  function Harness() {
    const [v, setV] = useState('');
    return (
      <>
        <CellphoneInput value={v} onChange={setV} />
        <button type="button">Next</button>
      </>
    );
  }

  it('explains the problem as soon as the person leaves the field, and clears it when they type again', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Cellphone number');
    await userEvent.type(input, '011 555 0134');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('That is a landline number. Enter a cellphone number instead.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(input, '{backspace}');
    expect(screen.queryByText(/landline/)).not.toBeInTheDocument();
  });
});
