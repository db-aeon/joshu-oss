"use client"

import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Check, Pipette } from "lucide-react"

const SOLIDS = [
  "#000000",
  "#ffffff",
  "#71717a",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#f43f5e",
  // Shades of gray
  "#18181b",
  "#27272a",
  "#3f3f46",
  "#52525b",
  "#a1a1aa",
  "#d4d4d8",
  "#e4e4e7",
  "#f4f4f5",
  // Pastel
  "#fecaca",
  "#fed7aa",
  "#fef3c7",
  "#bbf7d0",
  "#99f6e4",
  "#bfdbfe",
  "#c7d2fe",
  "#ddd6fe",
  "#f5d0fe",
  "#fda4af",
]

interface ColorPickerProps {
  value: string
  onChange: (value: string) => void
  className?: string
  disabled?: boolean
}

export function ColorPicker({ value, onChange, className, disabled = false }: ColorPickerProps) {
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Extract hex and opacity from rgba or hex
  const hexValue = React.useMemo(() => {
    if (value.startsWith("rgba")) {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/)
      if (match) {
        const r = parseInt(match[1])
        const g = parseInt(match[2])
        const b = parseInt(match[3])
        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
      }
    }
    return value || "#000000"
  }, [value])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          className={cn(
            "w-6 h-6 p-0 rounded-sm border border-border/40 shadow-sm shrink-0",
            className
          )}
          style={{ background: value || "#000000" }}
          disabled={disabled}
        >
          <span className="sr-only">Pick a color</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" side="left" align="start" sideOffset={12}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Colors</span>
            <div className="flex items-center gap-1">
              <Input
                type="color"
                ref={inputRef}
                value={hexValue.startsWith("#") ? hexValue : "#000000"}
                onChange={(e) => onChange(e.target.value)}
                className="sr-only"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => inputRef.current?.click()}
                title="Advanced picker"
              >
                <Pipette className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-8 gap-1">
            {SOLIDS.map((s) => (
              <button
                key={s}
                className={cn(
                  "h-6 w-6 rounded-sm border border-border/20 hover:scale-110 transition-transform flex items-center justify-center"
                )}
                style={{ background: s }}
                onClick={() => onChange(s)}
              >
                {value.toLowerCase() === s.toLowerCase() && (
                  <Check className="h-3 w-3 text-white mix-blend-difference" />
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-2 border-t">
            <div className="flex-1">
              <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="h-7 text-[10px] font-mono"
                placeholder="#000000"
              />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

