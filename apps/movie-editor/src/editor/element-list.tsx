import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  Layers,
  MoreHorizontal,
  Music,
  Type,
  Video,
} from 'lucide-react';
import type { VideoElement } from './types';
import { useVideoEditor } from './editor-context';

export function ElementList() {
  const {
    source,
    selectedElementId,
    activeCompositionPath,
    selectElement,
    enterComposition,
  } = useVideoEditor();
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const rootElements = source?.elements ?? [];

  const activeCompositionIds = useMemo(
    () => new Set(activeCompositionPath.map((composition) => composition.id)),
    [activeCompositionPath],
  );

  useEffect(() => {
    if (activeCompositionPath.length === 0) return;
    setExpandedIds((prev) => {
      const next = { ...prev };
      for (const composition of activeCompositionPath) {
        next[composition.id] = true;
      }
      return next;
    });
  }, [activeCompositionPath]);

  if (!source || !source.elements) {
    return <div className="p-4 text-xs text-muted-foreground">No elements found.</div>;
  }

  return (
    <div className="flex h-full flex-col bg-card/50">
      <div className="flex-1 overflow-y-auto p-2 scrollbar-none">
        <div className="space-y-0.5">
          <ElementTree
            elements={rootElements}
            expandedIds={expandedIds}
            selectedElementId={selectedElementId}
            activeCompositionIds={activeCompositionIds}
            onToggleExpand={(id) =>
              setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }))
            }
            onSelect={(id) => void selectElement(id)}
            onEnterComposition={enterComposition}
          />
        </div>
      </div>
    </div>
  );
}

function ElementTree({
  elements,
  expandedIds,
  selectedElementId,
  activeCompositionIds,
  onToggleExpand,
  onSelect,
  onEnterComposition,
  level = 0,
}: {
  elements: VideoElement[];
  expandedIds: Record<string, boolean>;
  selectedElementId: string | null;
  activeCompositionIds: Set<string>;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
  onEnterComposition: (id: string) => void;
  level?: number;
}) {
  const sortedElements = [...elements].sort((a, b) => (b.track || 0) - (a.track || 0));

  return (
    <>
      {sortedElements.map((element, idx) => {
        const isComposition = element.type === 'composition';
        const hasChildren = isComposition && (element.elements?.length ?? 0) > 0;
        const isExpanded = hasChildren && expandedIds[element.id] !== false;
        const isSelected = selectedElementId === element.id;
        const isActiveComposition = activeCompositionIds.has(element.id);

        return (
          <div key={element.id ? `${element.id}-${idx}` : `el-${level}-${idx}`}>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'h-7 w-5 shrink-0 text-muted-foreground/50 hover:text-foreground',
                  !hasChildren && 'opacity-0 pointer-events-none',
                )}
                onClick={() => hasChildren && onToggleExpand(element.id)}
              >
                {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'flex-1 justify-start gap-2 px-2 text-xs font-normal h-8 rounded-md transition-all group min-w-0',
                  isSelected
                    ? 'bg-primary/10 text-primary hover:bg-primary/15 font-medium shadow-sm'
                    : isActiveComposition
                      ? 'bg-primary/5 text-foreground hover:bg-primary/10'
                      : 'text-muted-foreground/80 hover:text-foreground hover:bg-muted/50',
                )}
                style={{ paddingLeft: `${Math.max(0, level * 12)}px` }}
                onClick={() => onSelect(element.id)}
                onDoubleClick={() => {
                  if (isComposition) {
                    onEnterComposition(element.id);
                  }
                }}
              >
                <ElementIcon
                  type={element.type}
                  className={cn(
                    'h-3.5 w-3.5 transition-colors shrink-0',
                    isSelected
                      ? 'text-primary'
                      : isActiveComposition
                        ? 'text-foreground/70'
                        : 'text-muted-foreground/40 group-hover:text-foreground/60',
                  )}
                />
                <span className="truncate flex-1 text-left">{element.name || element.type}</span>
                {isSelected && (
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-in fade-in zoom-in duration-300" />
                )}
              </Button>
            </div>

            {hasChildren && isExpanded ? (
              <div className="mt-0.5">
                <ElementTree
                  elements={element.elements ?? []}
                  expandedIds={expandedIds}
                  selectedElementId={selectedElementId}
                  activeCompositionIds={activeCompositionIds}
                  onToggleExpand={onToggleExpand}
                  onSelect={onSelect}
                  onEnterComposition={onEnterComposition}
                  level={level + 1}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function ElementIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'text':
      return <Type className={className} />;
    case 'image':
      return <ImageIcon className={className} />;
    case 'video':
      return <Video className={className} />;
    case 'audio':
      return <Music className={className} />;
    case 'shape':
      return <Box className={className} />;
    case 'composition':
      return <Layers className={className} />;
    default:
      return <MoreHorizontal className={className} />;
  }
}
