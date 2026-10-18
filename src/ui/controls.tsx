import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
}) {
  const { label, value, min, max, step = 1, unit = '', format, onChange, onStart, onEnd } = props;
  return (
    <div className="slider">
      <label>{label}</label>
      <span className="val">{format ? format(value) : `${Math.round(value * 100) / 100}${unit}`}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onStart}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onKeyUp={onEnd}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

export function NumberField(props: { label?: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  const [text, setText] = useState(String(round(props.value)));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(round(props.value)));
  }, [props.value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v)) {
      let c = v;
      if (props.min !== undefined) c = Math.max(props.min, c);
      if (props.max !== undefined) c = Math.min(props.max, c);
      if (c !== props.value) props.onChange(c);
      setText(String(round(c)));
    } else setText(String(round(props.value)));
  };
  return (
    <label className="row" style={{ gap: 6, fontSize: 12, color: 'var(--text-2)', fontWeight: 700 }}>
      {props.label}
      <input
        className="input num"
        inputMode="decimal"
        value={text}
        step={props.step}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onChange={(e) => setText(e.target.value)}
      />
      {props.suffix && <span style={{ fontWeight: 400 }}>{props.suffix}</span>}
    </label>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;

export function Toggle(props: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle" style={props.disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

const SWATCHES = ['#1d2230', '#ffffff', '#4a5a8c', '#7a6ee0', '#d6597a', '#e9a23b', '#3f8f6b', '#2f8fbf', '#f4d35e', '#a0a8b8'];

/** 色＋透明度（#rrggbbaa） */
export function ColorField(props: { label?: string; value: string; onChange: (v: string) => void; alpha?: boolean }) {
  const hex = props.value.slice(0, 7);
  const a = props.value.length === 9 ? parseInt(props.value.slice(7), 16) / 255 : 1;
  const setA = (na: number) => {
    const aa = Math.round(Math.max(0, Math.min(1, na)) * 255);
    props.onChange(aa === 255 ? hex : hex + aa.toString(16).padStart(2, '0'));
  };
  return (
    <div className="field">
      {props.label && <span className="field-label">{props.label}</span>}
      <div className="color-row">
        <input type="color" value={hex} onChange={(e) => props.onChange(e.target.value + (a < 1 ? props.value.slice(7) : ''))} />
        <div className="swatches">
          {SWATCHES.map((c) => (
            <button key={c} className="swatch" style={{ background: c }} aria-label={c} onClick={() => props.onChange(c + (a < 1 ? props.value.slice(7) : ''))} />
          ))}
        </div>
      </div>
      {props.alpha && <Slider label="不透明度" value={Math.round(a * 100)} min={0} max={100} unit="%" onChange={(v) => setA(v / 100)} />}
    </div>
  );
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={'seg' + (props.small ? ' small' : '')} role="tablist">
      {props.options.map((o) => (
        <button key={o.value} className={o.value === props.value ? 'on' : ''} onClick={() => props.onChange(o.value)} role="tab" aria-selected={o.value === props.value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'wide' | 'narrow' }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props.onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={'modal ' + (props.size ?? '')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="ibtn" onClick={props.onClose} aria-label="閉じる">
            <X size={22} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function FlipHIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" strokeDasharray="2 3" />
      <path d="M9 7 4 17h5z" />
      <path d="m15 7 5 10h-5z" fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}
export function FlipVIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h18" strokeDasharray="2 3" />
      <path d="M7 9 17 4v5z" />
      <path d="m7 15 10 5v-5z" fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}
