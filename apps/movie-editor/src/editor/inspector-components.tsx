
import { ReactNode, useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

import { ColorPicker } from '@/components/ui/color-picker';

// --- Elegant sidebar density ---
export const INSPECTOR_LABEL_CLASS = "text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1 block";
export const INSPECTOR_INPUT_CLASS = "h-7 text-xs px-2 bg-muted/40 border-none shadow-none focus-visible:ring-1 focus-visible:ring-ring transition-all";
export const INSPECTOR_SELECT_TRIGGER_CLASS = "h-7 text-xs px-2 bg-muted/40 border-none shadow-none focus-visible:ring-1 focus-visible:ring-ring transition-all";
export const INSPECTOR_TOGGLE_ITEM_CLASS = "h-7 w-7 p-0 data-[state=on]:bg-background data-[state=on]:shadow-sm";

export function PropertyGroup({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/collapsible">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-bold text-muted-foreground/60 uppercase tracking-widest hover:text-foreground transition-colors bg-muted/20">
        <span>{title}</span>
        <ChevronDown className="h-3 w-3 group-data-[state=closed]/collapsible:-rotate-90 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 py-4 space-y-4 bg-background/50 border-b border-border/30">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ScratchToggleRow({
  label,
  defaultChecked,
  resetKey,
  onCheckedChange,
  children,
  disabled = false,
}: {
  label: string;
  defaultChecked: boolean;
  resetKey: string;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const [localChecked, setLocalChecked] = useState(defaultChecked);

  useEffect(() => {
    setLocalChecked(defaultChecked);
  }, [resetKey, defaultChecked]);

  return (
    <div className="group flex w-full flex-col gap-2 py-3 border-b border-border/30 last:border-0">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-foreground/90">{label}</div>
        <Switch
          checked={localChecked}
          onCheckedChange={(v) => {
            if (disabled) return;
            const next = v === true;
            setLocalChecked(next);
            onCheckedChange(next);
          }}
          className="scale-75 origin-right"
          disabled={disabled}
        />
      </div>
      {localChecked && children ? (
        <div className="mt-1 animate-in fade-in slide-in-from-top-1 duration-200">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function LabelBelowInput({ label, value, onChange, className, type = "text", placeholder, disabled = false }: { label: string; value: any; onChange: (v: string) => void; className?: string; type?: string, placeholder?: string, disabled?: boolean }) {
  return (
    <div className={cn("grid w-full gap-1", className)}>
      <Label className={INSPECTOR_LABEL_CLASS}>{label}</Label>
      <Input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INSPECTOR_INPUT_CLASS}
        disabled={disabled}
      />
    </div>
  );
}

export function GridRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="text-[10px] font-bold text-muted-foreground/40 uppercase tracking-tight">{label}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                {children}
            </div>
        </div>
    )
}

export function NumberInput({ label, value, onChange, className, step = 1, min, max, suffix, placeholder, disabled = false }: { label: string; value: any; onChange: (v: number) => void; className?: string; step?: number; min?: number; max?: number; suffix?: string; placeholder?: string, disabled?: boolean }) {
  return (
    <div className={cn("grid w-full gap-1", className)}>
      <Label className={INSPECTOR_LABEL_CLASS}>{label}</Label>
      <div className="relative">
        <Input
          type="number"
          step={step}
          min={min}
          max={max}
          value={value ?? ''}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          placeholder={placeholder}
          className={cn(INSPECTOR_INPUT_CLASS, suffix && "pr-7")}
          disabled={disabled}
        />
        {suffix && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/40 pointer-events-none font-medium">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

export function SelectField({ label, value, onChange, options, className, disabled = false }: { label: string; value: any; onChange: (v: string) => void; options: { label: string; value: string }[]; className?: string, disabled?: boolean }) {
  return (
    <div className={cn("grid w-full gap-1", className)}>
      <Label className={INSPECTOR_LABEL_CLASS}>{label}</Label>
      <Select value={value ?? ''} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className={INSPECTOR_SELECT_TRIGGER_CLASS}>
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
            {options.map(opt => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function UnderlineSelect({
  value,
  onChange,
  placeholder,
  label,
  options,
  className,
  disabled = false,
}: {
  value: any;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  options: { label: string; value: string }[];
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn('grid w-full gap-1', className)}>
      <Label className={INSPECTOR_LABEL_CLASS}>{label}</Label>
      <Select value={value ?? ''} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className={INSPECTOR_SELECT_TRIGGER_CLASS}>
          <SelectValue placeholder={placeholder ?? 'Select...'} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function UnderlineTextInput({
  value,
  onChange,
  label,
  placeholder,
  className,
  disabled = false,
}: {
  value: any;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn('grid w-full gap-1', className)}>
      <Label className={INSPECTOR_LABEL_CLASS}>{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INSPECTOR_INPUT_CLASS}
        disabled={disabled}
      />
    </div>
  );
}

export function normalizeToRgba(color: string, opacityPercent: number): string {
  const p = Math.max(0, Math.min(100, opacityPercent));
  const a = p / 100;
  const hex = (color || '').trim();

  const hexMatch = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const raw = hexMatch[1];
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  const rgbaMatch = hex.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgbaMatch) {
    const r = Math.round(Number(rgbaMatch[1]));
    const g = Math.round(Number(rgbaMatch[2]));
    const b = Math.round(Number(rgbaMatch[3]));
    return `rgba(${r},${g},${b},${a})`;
  }

  return color;
}

export function ColorRowLite({
  title = 'Color',
  value,
  onChange,
  disabled = false,
}: {
  title?: string;
  value: any;
  onChange: (v: any) => void;
  disabled?: boolean;
}) {
  const isGradientArray = Array.isArray(value);
  const stringValue = isGradientArray ? '' : String(value ?? '');

  const opacity = (() => {
    const m = stringValue.match(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)$/i);
    if (!m) return 100;
    const a = Number(m[1]);
    if (Number.isNaN(a)) return 100;
    return Math.round(a * 100);
  })();

  return (
    <div className="flex items-center gap-3 justify-between py-1">
      <h2 className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-tight min-w-[50px]">{title}</h2>
      <div className="flex gap-1.5 items-center flex-1 justify-end">
        {!isGradientArray ? (
          <ColorPicker 
            value={stringValue} 
            onChange={onChange} 
            disabled={disabled}
          />
        ) : (
          <div
            style={{ background: '#ddd' }}
            className="border border-border/40 w-6 h-6 rounded-sm shadow-sm shrink-0"
            title="Gradient (read-only)"
          />
        )}
        <Input
          value={isGradientArray ? '[gradient]' : stringValue}
          disabled={isGradientArray || disabled}
          onChange={(e) => onChange(e.target.value)}
          type="text"
          className="h-7 w-[90px] text-[10px] font-mono bg-muted/30 border-none shadow-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Input
          value={`${opacity}%`}
          disabled={isGradientArray || disabled}
          onChange={(e) => {
            const raw = e.target.value.replace('%', '').trim();
            const next = Math.max(0, Math.min(100, Number(raw || 0)));
            onChange(normalizeToRgba(stringValue || '#333333', next));
          }}
          type="text"
          className="h-7 w-12 text-[10px] bg-muted/30 border-none shadow-none focus-visible:ring-1 focus-visible:ring-ring text-center"
        />
      </div>
    </div>
  );
}
