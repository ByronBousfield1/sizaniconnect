import { useState } from 'react';
import { parseSaCellphone } from '../lib/phone';
import { TextInput } from './ui';

/** A cellphone field that checks the number when the person moves on, before anything is sent. */
export function CellphoneInput({
  label = 'Cellphone number',
  optional = true,
  value,
  onChange,
  error,
}: {
  label?: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const [local, setLocal] = useState<string | undefined>();
  return (
    <TextInput
      label={label}
      hint={`${optional ? 'Optional. ' : ''}South African cellphone, for example 082 555 0134`}
      type="tel"
      inputMode="tel"
      autoComplete="tel-national"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        if (local) setLocal(undefined);
      }}
      onBlur={() => {
        if (!value.trim()) return setLocal(undefined);
        const r = parseSaCellphone(value);
        setLocal(r.ok ? undefined : r.message);
      }}
      error={local ?? error}
    />
  );
}
