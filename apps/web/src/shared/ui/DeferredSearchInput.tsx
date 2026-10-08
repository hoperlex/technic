import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from 'antd';

const SEARCH_DEBOUNCE_MS = 300;

type DeferredSearchInputProps = Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange' | 'onPressEnter'
> & {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
};

/** Keep the draft visible while a server list catches up with the submitted search. */
export function DeferredSearchInput({ value, onChange, ...inputProps }: DeferredSearchInputProps) {
  const [text, setText] = useState(value ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const submitted = useRef<string | undefined>(value);

  // Acknowledging our own trimmed query must not erase a space typed after the last pause.
  useEffect(() => {
    if (value !== submitted.current) {
      clearTimeout(timer.current);
      submitted.current = value;
      setText(value ?? '');
    }
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (raw: string) => {
    const next = raw.trim() || undefined;
    if (next === submitted.current) return;
    submitted.current = next;
    onChange(next);
  };

  return (
    <Input
      {...inputProps}
      allowClear
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => send(next), SEARCH_DEBOUNCE_MS);
      }}
      onPressEnter={() => {
        clearTimeout(timer.current);
        send(text);
      }}
    />
  );
}
