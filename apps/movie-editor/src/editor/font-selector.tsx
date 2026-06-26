import * as React from "react";
import { Check, ChevronsUpDown, Type } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { VideoFont } from "./types";

const BUILTIN_FONTS = [
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
];

export function FontSelector({
  value,
  onSelect,
  disabled = false,
}: {
  value: string;
  onSelect: (family: string, fontData?: VideoFont) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-7 w-full justify-between bg-muted/40 border-none text-xs font-normal"
          disabled={disabled}
        >
          <span className="truncate" style={{ fontFamily: value }}>
            {value || "Select font..."}
          </span>
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0" side="left" align="start" sideOffset={12}>
        <Command>
          <CommandList className="max-h-[300px]">
            <CommandEmpty>No fonts found.</CommandEmpty>
            <CommandGroup heading="Fonts">
              {BUILTIN_FONTS.map((family) => (
                <CommandItem
                  key={family}
                  value={family}
                  onSelect={() => {
                    onSelect(family);
                    setOpen(false);
                  }}
                  className="cursor-pointer"
                >
                  <Check className={cn("mr-2 h-4 w-4", value === family ? "opacity-100" : "opacity-0")} />
                  <span style={{ fontFamily: family }}>{family}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
