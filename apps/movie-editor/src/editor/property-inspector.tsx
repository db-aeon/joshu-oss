
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { sanitizeSourceForCreatomate } from '@/lib/creatomate-source';
import { Settings2, Trash2, Upload, Video as VideoIcon } from 'lucide-react';
import { useVideoEditor } from './editor-context';
import type { ReactNode } from 'react';
import { useState, useMemo } from 'react';
import { 
  INSPECTOR_LABEL_CLASS, 
  INSPECTOR_INPUT_CLASS, 
  INSPECTOR_TOGGLE_ITEM_CLASS,
  INSPECTOR_SELECT_TRIGGER_CLASS,
  ScratchToggleRow,
  LabelBelowInput,
  GridRow,
  NumberInput,
  SelectField,
  ColorRowLite,
  PropertyGroup,
  UnderlineTextInput,
  UnderlineSelect
} from './inspector-components';
import { 
  Maximize, 
  Minimize2, 
  MoveHorizontal, 
  MoveVertical, 
  Type as TypeIcon,
  Scaling,
  Square as SquareIcon
} from 'lucide-react';
import { FontSelector } from './font-selector';

function updateElementTree(elements: any[], targetId: string, updater: (element: any) => any): any[] {
  return elements.map((element) => {
    if (element.id === targetId) {
      return updater(element);
    }

    if (element.elements?.length) {
      return {
        ...element,
        elements: updateElementTree(element.elements, targetId, updater),
      };
    }

    return element;
  });
}

function removeElementTree(elements: any[], targetId: string): any[] {
  return elements.flatMap((element) => {
    if (element.id === targetId) {
      return [];
    }

    if (element.elements?.length) {
      return [
        {
          ...element,
          elements: removeElementTree(element.elements, targetId),
        },
      ];
    }

    return [element];
  });
}

function TextSizingSelector({ element, onChanges }: { element: any, onChanges: (changes: any) => void }) {
  const currentMode = useMemo(() => {
    const { width, height, font_size } = element;
    if (!width && !height && font_size) return 'fixed-font-auto-size';
    if (width && height && font_size) return 'fixed-font-fixed-size';
    if (width && height && !font_size) return 'auto-font-fixed-size';
    if (!width && height && !font_size) return 'auto-font-auto-width-fixed-height';
    if (width && !height && !font_size) return 'auto-font-fixed-width-auto-height';
    return 'custom';
  }, [element.width, element.height, element.font_size]);

  const modes = [
    { 
      id: 'fixed-font-auto-size', 
      title: 'Fixed Font, Auto Width/Height', 
      icon: <TypeIcon className="h-3 w-3" />,
      changes: { font_size: element.font_size || '6vmin', width: undefined, height: undefined }
    },
    { 
      id: 'fixed-font-fixed-size', 
      title: 'Fixed Font, Fixed Width/Height', 
      icon: <SquareIcon className="h-3 w-3" />,
      changes: { font_size: element.font_size || '6vmin', width: element.width || '60%', height: element.height || '20%' }
    },
    { 
      id: 'auto-font-fixed-size', 
      title: 'Auto Font, Fixed Width/Height', 
      icon: <Scaling className="h-3 w-3" />,
      changes: { font_size: undefined, width: element.width || '60%', height: element.height || '20%' }
    },
    { 
      id: 'auto-font-auto-width-fixed-height', 
      title: 'Auto Font, Auto Width, Fixed Height', 
      icon: <MoveVertical className="h-3 w-3" />,
      changes: { font_size: undefined, width: undefined, height: element.height || '20%' }
    },
    { 
      id: 'auto-font-fixed-width-auto-height', 
      title: 'Auto Font, Fixed Width, Auto Height', 
      icon: <MoveHorizontal className="h-3 w-3" />,
      changes: { font_size: undefined, width: element.width || '60%', height: undefined }
    },
  ];

  return (
    <div className="space-y-2">
      <Label className={INSPECTOR_LABEL_CLASS}>Sizing Mode</Label>
      <div className="flex bg-muted/30 p-0.5 rounded-md w-fit">
        {modes.map((mode) => (
          <Button
            key={mode.id}
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 transition-all p-0",
              currentMode === mode.id ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            title={mode.title}
            onClick={() => onChanges(mode.changes)}
          >
            {mode.icon}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Global Video Project Properties
 */
export function VideoProperties({ isReadonly = false }: { isReadonly?: boolean }) {
  const { source, setSource, preview, type } = useVideoEditor();

  if (!source) return null;

  const handleChange = async (key: string, value: any) => {
    if (isReadonly) return;
    const newSource = { ...source, [key]: value };
    setSource(newSource);
    if (preview) {
      try {
        await preview.setSource(sanitizeSourceForCreatomate(newSource), true);
      } catch (e) {
        console.warn('[VideoEditor] Failed to sync global source to preview', e);
      }
    }
  };

  return (
    <div className="flex h-full flex-col bg-background/50">
      <div className="flex-1 overflow-y-auto pb-8">
        <div className="px-3 py-4 space-y-6">
          {type !== 'slide' && (
            <GridRow label="Time">
              <LabelBelowInput label="Start" value="Auto" onChange={() => {}} className="opacity-50 pointer-events-none" disabled={isReadonly} />
              <NumberInput label="Duration" value={source.duration} onChange={(v) => handleChange('duration', isNaN(v) ? undefined : v)} suffix="s" placeholder="Auto" disabled={isReadonly} />
            </GridRow>
          )}

          <GridRow label="Size">
            <NumberInput label="Width" value={source.width} onChange={(v) => handleChange('width', v)} suffix="px" disabled={isReadonly} />
            <NumberInput label="Height" value={source.height} onChange={(v) => handleChange('height', v)} suffix="px" disabled={isReadonly} />
          </GridRow>

          <div className="space-y-4">
            <SelectField 
              label="Format" 
              value={source.output_format || 'mp4'} 
              onChange={(v) => handleChange('output_format', v)}
              options={[
                { label: 'MP4', value: 'mp4' },
                { label: 'GIF', value: 'gif' },
                { label: 'PNG', value: 'png' },
                { label: 'JPG', value: 'jpg' },
              ]}
              disabled={isReadonly}
            />
            {type !== 'slide' && (
              <SelectField 
                label="Frame Rate" 
                value={source.frame_rate || 'auto'} 
                onChange={(v) => handleChange('frame_rate', v)}
                options={[
                  { label: 'Auto Detect', value: 'auto' },
                  { label: '24 fps', value: '24' },
                  { label: '30 fps', value: '30' },
                  { label: '60 fps', value: '60' },
                ]}
                disabled={isReadonly}
              />
            )}
          </div>

          <ScratchToggleRow
            label="Fill"
            defaultChecked={Boolean(source.fill_color)}
            resetKey="global-fill"
            onCheckedChange={(checked) => {
              handleChange('fill_color', checked ? (source.fill_color || '#000000') : '');
            }}
            disabled={isReadonly}
          >
            <ColorRowLite title="Color" value={source.fill_color || '#000000'} onChange={(v) => handleChange('fill_color', v)} disabled={isReadonly} />
          </ScratchToggleRow>
        </div>
      </div>
    </div>
  );
}

/**
 * Individual Element Property Inspector
 */
export function PropertyInspector({ isReadonly = false }: { isReadonly?: boolean }) {
  const { source, selectedElementId, selectedElement, setSource, preview, setSelectedElementId, type } = useVideoEditor();
  const [activeTab, setActiveTab] = useState('properties' as 'properties' | 'animation');

  const element = useMemo(() => selectedElement, [selectedElement]);

  if (!element) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center bg-background/50">
        <div className="w-12 h-12 rounded-full bg-muted/30 flex items-center justify-center mb-4">
          <Settings2 className="h-6 w-6 text-muted-foreground/40" />
        </div>
        <h3 className="text-xs font-semibold text-foreground/80 mb-1">No Selection</h3>
        <p className="text-[10px] text-muted-foreground/60 max-w-[160px] leading-relaxed">
          Select an element on the canvas or from the layers list to view its properties.
        </p>
      </div>
    );
  }

  const handleChange = async (key: string, value: any) => {
    if (isReadonly) return;
    handleChanges({ [key]: value });
  };

  const handleChanges = async (changes: Record<string, any>) => {
    if (!source || isReadonly) return;
    const newElements = updateElementTree(source.elements, element.id, (el) => {
      const next = { ...el };
      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined) {
          delete (next as any)[k];
        } else {
          (next as any)[k] = v;
        }
      }
      return next;
    });
    const newSource = { ...source, elements: newElements };
    setSource(newSource);
    if (preview) {
      try {
        await preview.setSource(sanitizeSourceForCreatomate(newSource), true);
      } catch (e) {
        console.warn('[VideoEditor] Failed to sync source to preview', e);
      }
    }
  };

  const handleDelete = async () => {
    if (!source || !preview) return;
    const newElements = removeElementTree(source.elements, element.id);
    const newSource = { ...source, elements: newElements };
    setSource(newSource);
    setSelectedElementId(null);
    await preview.setSource(sanitizeSourceForCreatomate(newSource), true);
  };

  const isAutoFont = element.type === 'text' && !element.font_size;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-2 py-1.5 text-xs font-medium text-muted-foreground flex items-center justify-between shrink-0 bg-muted/5">
        <div className="flex items-center gap-1">
          <div className="flex bg-muted/50 p-0.5 rounded-md">
            <Button
              variant={activeTab === 'properties' ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                "h-6 px-3 text-[10px] rounded-[4px] transition-all",
                activeTab === 'properties' ? "bg-background shadow-sm text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setActiveTab('properties')}
            >
              Properties
            </Button>
            <Button
              variant={activeTab === 'animation' ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                "h-6 px-3 text-[10px] rounded-[4px] transition-all",
                activeTab === 'animation' ? "bg-background shadow-sm text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setActiveTab('animation')}
            >
              Animation
            </Button>
          </div>
        </div>
        {!isReadonly && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground/50 hover:text-destructive transition-colors" onClick={handleDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pb-8">
        {activeTab === 'properties' ? (
          <div>
            {/* --- NAME --- */}
            <div className="p-3 border-b border-border/30">
                <Label className={INSPECTOR_LABEL_CLASS}>Element Name</Label>
                <Input
                    value={element.name || ''}
                    onChange={(e) => handleChange('name', e.target.value)}
                    className={INSPECTOR_INPUT_CLASS}
                    placeholder={element.type}
                    disabled={isReadonly}
                />
            </div>

            {/* --- ARRANGE --- */}
            <PropertyGroup title="Arrange" defaultOpen={true}>
                {type !== 'slide' && (
                  <GridRow label="Time">
                      <LabelBelowInput 
                        label="Start" 
                        value={element.time} 
                        onChange={(v) => {
                          const val = parseFloat(v);
                          handleChange('time', isNaN(val) ? undefined : val);
                        }} 
                        placeholder="Auto" 
                        disabled={isReadonly}
                      />
                      <LabelBelowInput 
                        label="Duration" 
                        value={element.duration} 
                        onChange={(v) => {
                          const val = parseFloat(v);
                          handleChange('duration', isNaN(val) ? undefined : val);
                        }} 
                        placeholder="Auto" 
                        disabled={isReadonly}
                      />
                  </GridRow>
                )}

                <GridRow label="Position">
                    <LabelBelowInput label="X" value={element.x} onChange={(v) => handleChange('x', v)} disabled={isReadonly} />
                    <LabelBelowInput label="Y" value={element.y} onChange={(v) => handleChange('y', v)} disabled={isReadonly} />
                </GridRow>
                <GridRow label="Size">
                    <LabelBelowInput label="Width" value={element.width} onChange={(v) => handleChange('width', v)} placeholder="Auto" className={cn(!element.width && "opacity-60")} disabled={isReadonly} />
                    <LabelBelowInput label="Height" value={element.height} onChange={(v) => handleChange('height', v)} placeholder="Auto" className={cn(!element.height && "opacity-60")} disabled={isReadonly} />
                </GridRow>
            </PropertyGroup>

            {/* --- TRANSFORM --- */}
            <PropertyGroup title="Transform" defaultOpen={false}>
                <GridRow label="Anchor">
                    <LabelBelowInput label="X" value={element.x_anchor ?? '50%'} onChange={(v) => handleChange('x_anchor', v)} disabled={isReadonly} />
                    <LabelBelowInput label="Y" value={element.y_anchor ?? '50%'} onChange={(v) => handleChange('y_anchor', v)} disabled={isReadonly} />
                </GridRow>
                <GridRow label="Alignment">
                    <LabelBelowInput label="X" value={element.x_alignment ?? '50%'} onChange={(v) => handleChange('x_alignment', v)} disabled={isReadonly} />
                    <LabelBelowInput label="Y" value={element.y_alignment ?? '50%'} onChange={(v) => handleChange('y_alignment', v)} disabled={isReadonly} />
                </GridRow>
                <GridRow label="Scale">
                    <LabelBelowInput label="X" value={element.x_scale ?? '100%'} onChange={(v) => handleChange('x_scale', v)} disabled={isReadonly} />
                    <LabelBelowInput label="Y" value={element.y_scale ?? '100%'} onChange={(v) => handleChange('y_scale', v)} disabled={isReadonly} />
                </GridRow>
                <GridRow label="Skew">
                    <LabelBelowInput label="X" value={element.x_skew ?? '0°'} onChange={(v) => handleChange('x_skew', v)} disabled={isReadonly} />
                    <LabelBelowInput label="Y" value={element.y_skew ?? '0°'} onChange={(v) => handleChange('y_skew', v)} disabled={isReadonly} />
                </GridRow>
                <GridRow label="Z-Rotation & 3D">
                    <LabelBelowInput label="Z" value={element.z_rotation ?? '0°'} onChange={(v) => handleChange('z_rotation', v)} disabled={isReadonly} />
                    <LabelBelowInput label="3D Persp" value={element.perspective ?? 'auto'} onChange={(v) => handleChange('perspective', v)} disabled={isReadonly} />
                </GridRow>
                <GridRow label="XY Rotation">
                    <LabelBelowInput label="X" value={element.x_rotation ?? '0°'} onChange={(v) => handleChange('x_rotation', v)} disabled={isReadonly} />
                    <LabelBelowInput label="Y" value={element.y_rotation ?? '0°'} onChange={(v) => handleChange('y_rotation', v)} disabled={isReadonly} />
                </GridRow>
            </PropertyGroup>

            {/* --- TEXT SETTINGS --- */}
            {element.type === 'text' && (
              <>
                <PropertyGroup title="Content" defaultOpen={true}>
                  <div className="space-y-4">
                    <div className="grid gap-2">
                      <Label className={INSPECTOR_LABEL_CLASS}>Text Content</Label>
                      <Textarea
                        value={element.text || ''}
                        onChange={(e) => handleChange('text', e.target.value)}
                        className="min-h-[72px] text-xs bg-muted/20 border-none resize-none focus-visible:ring-1"
                        disabled={isReadonly}
                      />
                    </div>
                  </div>
                </PropertyGroup>

                <PropertyGroup title="Font" defaultOpen={true}>
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <Label className={INSPECTOR_LABEL_CLASS}>Family</Label>
                        <FontSelector 
                          value={element.font_family || 'Arial'} 
                          disabled={isReadonly}
                          onSelect={async (family, fontData) => {
                            if (!source || isReadonly) return;
                            
                            const newElements = updateElementTree(source.elements, element.id, (el) => ({
                              ...el,
                              font_family: family,
                            }));

                            let newFonts = source.fonts || [];
                            if (fontData?.source?.trim()) {
                              const exists = newFonts.some(f => f.family === family);
                              if (!exists) {
                                newFonts = [...newFonts, fontData];
                              }
                            }

                            const newSource = { 
                              ...source, 
                              elements: newElements,
                              fonts: newFonts
                            };
                            
                            await setSource(newSource);
                            if (preview) {
                              try {
                                await preview.setSource(sanitizeSourceForCreatomate(newSource), true);
                              } catch (e) {
                                console.warn('[VideoEditor] Failed to sync source to preview', e);
                              }
                            }
                          }} 
                        />
                      </div>
                      <UnderlineSelect 
                        label="Weight" 
                        value={element.font_weight || '400'} 
                        onChange={(v) => handleChange('font_weight', v)}
                        options={['100','200','300','400','500','600','700','800','900'].map(w => ({ label: w, value: w }))}
                        disabled={isReadonly}
                      />
                    </div>
                      <UnderlineSelect 
                        label="Style" 
                        value={element.font_style ?? 'normal'} 
                        onChange={(v) => handleChange('font_style', v)}
                        options={[{ label: 'Normal', value: 'normal' }, { label: 'Italic', value: 'italic' }]}
                        disabled={isReadonly}
                      />
                      {!isAutoFont ? (
                        <UnderlineTextInput label="Size (Fixed)" value={element.font_size ?? '6vmin'} onChange={(v) => handleChange('font_size', v)} disabled={isReadonly} />
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                           <UnderlineTextInput label="Min Size" value={element.font_size_minimum ?? '1vmin'} onChange={(v) => handleChange('font_size_minimum', v)} disabled={isReadonly} />
                           <UnderlineTextInput label="Max Size" value={element.font_size_maximum ?? '100vmin'} onChange={(v) => handleChange('font_size_maximum', v)} disabled={isReadonly} />
                        </div>
                      )}
                      <div className="col-span-2 mt-1">
                        <TextSizingSelector element={element} onChanges={handleChanges} />
                      </div>
                    
                      <UnderlineTextInput label="Letter" value={element.letter_spacing ?? '0%'} onChange={(v) => handleChange('letter_spacing', v)} disabled={isReadonly} />
                      <UnderlineTextInput label="Line" value={element.line_height ?? '115%'} onChange={(v) => handleChange('line_height', v)} disabled={isReadonly} />
                      <UnderlineSelect 
                        label="Wrap" 
                        value={element.text_wrap === false ? 'false' : 'true'} 
                        onChange={(v) => handleChange('text_wrap', v === 'true')}
                        options={[{ label: 'Wrap', value: 'true' }, { label: 'No Wrap', value: 'false' }]}
                        disabled={isReadonly}
                      />
                      <UnderlineSelect 
                        label="Clip" 
                        value={element.text_clip === false ? 'false' : 'true'} 
                        onChange={(v) => handleChange('text_clip', v === 'true')}
                        options={[{ label: 'Clip', value: 'true' }, { label: 'No Clip', value: 'false' }]}
                        disabled={isReadonly}
                      />
                  </div>
                </PropertyGroup>

                <PropertyGroup title="Alignment" defaultOpen={false}>
                  <GridRow label="Position">
                    <UnderlineSelect 
                      label="X" 
                      value={element.x_alignment ?? '50%'} 
                      onChange={(v) => handleChange('x_alignment', v)}
                      options={[{ label: 'Left', value: '0%' }, { label: 'Center', value: '50%' }, { label: 'Right', value: '100%' }]}
                      disabled={isReadonly}
                    />
                    <UnderlineSelect 
                      label="Y" 
                      value={element.y_alignment ?? '50%'} 
                      onChange={(v) => handleChange('y_alignment', v)}
                      options={[{ label: 'Top', value: '0%' }, { label: 'Middle', value: '50%' }, { label: 'Bottom', value: '100%' }]}
                      disabled={isReadonly}
                    />
                  </GridRow>
                </PropertyGroup>

                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Transcription"
                    defaultChecked={Boolean(element.transcript_source)}
                    resetKey={`${element.id}:transcript`}
                    onCheckedChange={(checked) => handleChange('transcript_source', checked ? 'auto' : '')}
                    disabled={isReadonly}
                  >
                    <div className="space-y-3 mt-2 pb-2">
                      <UnderlineSelect 
                        label="Effect" 
                        value={element.transcript_effect || 'color'} 
                        onChange={(v) => handleChange('transcript_effect', v)}
                        options={['color','karaoke','highlight','fade','bounce','slide','enlarge'].map(e => ({ label: e.charAt(0).toUpperCase() + e.slice(1), value: e }))}
                        disabled={isReadonly}
                      />
                      <GridRow label="Split & Length">
                        <UnderlineSelect 
                          label="Split" 
                          value={element.transcript_split || 'none'} 
                          onChange={(v) => handleChange('transcript_split', v)}
                          options={[{ label: 'None', value: 'none' }, { label: 'Word', value: 'word' }, { label: 'Line', value: 'line' }]}
                          disabled={isReadonly}
                        />
                        <UnderlineTextInput label="Max Length" value={element.transcript_maximum_length ?? 'auto'} onChange={(v) => handleChange('transcript_maximum_length', v)} disabled={isReadonly} />
                      </GridRow>
                      <UnderlineSelect 
                        label="Placement" 
                        value={element.transcript_placement || 'auto'} 
                        onChange={(v) => handleChange('transcript_placement', v)}
                        options={[{ label: 'Auto', value: 'auto' }, { label: 'Static', value: 'static' }, { label: 'Animate', value: 'animate' }]}
                        disabled={isReadonly}
                      />
                      <ColorRowLite title="T. Color" value={element.transcript_color || 'rgba(0, 0, 0, 0.3)'} onChange={(v) => handleChange('transcript_color', v)} disabled={isReadonly} />
                    </div>
                  </ScratchToggleRow>
                </div>

                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Text Background"
                    defaultChecked={Boolean(element.text_background_color)}
                    resetKey={`${element.id}:text-bg`}
                    onCheckedChange={(checked) => handleChange('text_background_color', checked ? (element.text_background_color || '#ffffff') : '')}
                    disabled={isReadonly}
                  >
                    <div className="space-y-3 mt-2 pb-2">
                      <ColorRowLite title="Color" value={element.text_background_color || '#ffffff'} onChange={(v) => handleChange('text_background_color', v)} disabled={isReadonly} />
                      <GridRow label="Padding">
                        <UnderlineTextInput label="X" value={element.text_background_padding_x ?? '1vmin'} onChange={(v) => handleChange('text_background_padding_x', v)} disabled={isReadonly} />
                        <UnderlineTextInput label="Y" value={element.text_background_padding_y ?? '1vmin'} onChange={(v) => handleChange('text_background_padding_y', v)} disabled={isReadonly} />
                      </GridRow>
                      <UnderlineTextInput label="Corners" value={element.text_background_border_radius ?? '0vmin'} onChange={(v) => handleChange('text_background_border_radius', v)} disabled={isReadonly} />
                    </div>
                  </ScratchToggleRow>
                </div>

                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Text Transform"
                    defaultChecked={Boolean(element.text_transform) && element.text_transform !== 'none'}
                    resetKey={`${element.id}:text-transform`}
                    onCheckedChange={(checked) => handleChange('text_transform', checked ? (element.text_transform !== 'none' ? element.text_transform : 'capitalize') : 'none')}
                    disabled={isReadonly}
                  >
                    <div className="pt-1 pb-2">
                      <UnderlineSelect 
                        label="Mode" 
                        value={element.text_transform || 'capitalize'} 
                        onChange={(v) => handleChange('text_transform', v)}
                        options={[
                          { label: 'Capitalize', value: 'capitalize' }, 
                          { label: 'Uppercase', value: 'uppercase' }, 
                          { label: 'Lowercase', value: 'lowercase' }
                        ]}
                        disabled={isReadonly}
                      />
                    </div>
                  </ScratchToggleRow>
                </div>
              </>
            )}

            {/* --- IMAGE / VIDEO / AUDIO SETTINGS --- */}
            {(element.type === 'image' || element.type === 'video' || element.type === 'audio') && (
              <>
                <PropertyGroup title="Source" defaultOpen={true}>
                  <div className="space-y-4">
                    <div className="grid gap-2">
                      <Label className={INSPECTOR_LABEL_CLASS}>Source URL</Label>
                      <Input
                        value={element.source || ''}
                        onChange={(e) => handleChange('source', e.target.value)}
                        className={INSPECTOR_INPUT_CLASS}
                        disabled={isReadonly}
                      />
                    </div>
                    {element.type !== 'audio' && (
                      <GridRow label="Fit & Crop">
                        <UnderlineSelect 
                          label="Fit" 
                          value={element.fit || 'cover'} 
                          onChange={(v) => handleChange('fit', v)}
                          options={[{ label: 'Cover', value: 'cover' }, { label: 'Contain', value: 'contain' }, { label: 'Fill', value: 'fill' }]}
                          disabled={isReadonly}
                        />
                        <UnderlineSelect 
                          label="Smart Crop" 
                          value={element.smart_crop === false ? 'false' : 'true'} 
                          onChange={(v) => handleChange('smart_crop', v === 'true')}
                          options={[{ label: 'Enabled', value: 'true' }, { label: 'Disabled', value: 'false' }]}
                          disabled={isReadonly}
                        />
                      </GridRow>
                    )}

                    {(element.type === 'video' || element.type === 'audio') && (
                      <>
                        <GridRow label="Trim">
                          <NumberInput
                            label="Start"
                            value={element.trim_start}
                            onChange={(v) => handleChange('trim_start', isNaN(v) ? undefined : v)}
                            placeholder="Auto"
                            disabled={isReadonly}
                          />
                          <NumberInput
                            label="Duration"
                            value={element.trim_duration}
                            onChange={(v) => handleChange('trim_duration', isNaN(v) ? undefined : v)}
                            placeholder="Auto"
                            disabled={isReadonly}
                          />
                        </GridRow>

                        <GridRow label="Audio Fade">
                          <NumberInput
                            label="In"
                            value={element.audio_fade_in}
                            onChange={(v) => handleChange('audio_fade_in', isNaN(v) ? undefined : v)}
                            placeholder="Auto"
                            disabled={isReadonly}
                          />
                          <NumberInput
                            label="Out"
                            value={element.audio_fade_out}
                            onChange={(v) => handleChange('audio_fade_out', isNaN(v) ? undefined : v)}
                            placeholder="Auto"
                            disabled={isReadonly}
                          />
                        </GridRow>

                        <GridRow label="Playback">
                          <NumberInput
                            label="Volume"
                            value={element.volume ? parseFloat(element.volume) : 100}
                            onChange={(v) => handleChange('volume', isNaN(v) ? undefined : `${v}%`)}
                            suffix="%"
                            disabled={isReadonly}
                          />
                          <NumberInput
                            label="Speed"
                            value={element.speed ? parseFloat(element.speed) : 100}
                            onChange={(v) => handleChange('speed', isNaN(v) ? undefined : `${v}%`)}
                            suffix="%"
                            disabled={isReadonly}
                          />
                          <UnderlineSelect 
                            label="Loop" 
                            value={element.loop ? 'true' : 'false'} 
                            onChange={(v) => handleChange('loop', v === 'true')}
                            options={[{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]}
                            disabled={isReadonly}
                          />
                        </GridRow>
                      </>
                    )}
                  </div>
                </PropertyGroup>
              </>
            )}

            {/* --- SHAPE SETTINGS --- */}
            {element.type === 'shape' && (
              <PropertyGroup title="Shape" defaultOpen={true}>
                <ColorRowLite title="Fill" value={element.fill_color || '#333333'} onChange={(v) => handleChange('fill_color', v)} disabled={isReadonly} />
              </PropertyGroup>
            )}

            {/* --- FILL, STROKE, SHADOW (FLATTENED) --- */}
            <div className="space-y-0">
                {/* Fill */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                      label="Fill"
                      defaultChecked={Boolean(element.fill_color)}
                      resetKey={`${element.id}:fill`}
                      onCheckedChange={(checked) => handleChange('fill_color', checked ? (element.fill_color || '#ffffff') : '')}
                      disabled={isReadonly}
                  >
                      <div className="pb-2">
                        <ColorRowLite title="Color" value={element.fill_color || '#ffffff'} onChange={(v) => handleChange('fill_color', v)} disabled={isReadonly} />
                      </div>
                  </ScratchToggleRow>
                </div>

                {/* Stroke */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                      label="Stroke"
                      defaultChecked={Boolean(element.stroke_color)}
                      resetKey={`${element.id}:stroke`}
                      onCheckedChange={(checked) => handleChange('stroke_color', checked ? (element.stroke_color || '#000000') : '')}
                      disabled={isReadonly}
                  >
                      <div className="space-y-3 pb-2">
                        <ColorRowLite title="Color" value={element.stroke_color || '#000000'} onChange={(v) => handleChange('stroke_color', v)} disabled={isReadonly} />
                        <UnderlineTextInput label="Width" value={element.stroke_width ?? '0vmin'} onChange={(v) => handleChange('stroke_width', v)} disabled={isReadonly} />
                      </div>
                  </ScratchToggleRow>
                </div>

                {/* Shadow */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                      label="Shadow"
                      defaultChecked={Boolean(element.shadow_color)}
                      resetKey={`${element.id}:shadow`}
                      onCheckedChange={(checked) => handleChange('shadow_color', checked ? (element.shadow_color || '#000000') : '')}
                      disabled={isReadonly}
                  >
                      <div className="space-y-3 pb-2">
                        <ColorRowLite title="Color" value={element.shadow_color || '#000000'} onChange={(v) => handleChange('shadow_color', v)} disabled={isReadonly} />
                        <GridRow label="Offset">
                            <UnderlineTextInput label="X" value={element.shadow_x ?? '0vmin'} onChange={(v) => handleChange('shadow_x', v)} disabled={isReadonly} />
                            <UnderlineTextInput label="Y" value={element.shadow_y ?? '0vmin'} onChange={(v) => handleChange('shadow_y', v)} disabled={isReadonly} />
                        </GridRow>
                        <UnderlineTextInput label="Blur" value={element.shadow_blur ?? '3vmin'} onChange={(v) => handleChange('shadow_blur', v)} disabled={isReadonly} />
                      </div>
                  </ScratchToggleRow>
                </div>

                {/* Opacity, Z-Index, Padding, Corners (FLATTENED WITH TOGGLES) --- */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Opacity"
                    defaultChecked={element.opacity !== undefined && element.opacity !== '100%'}
                    resetKey={`${element.id}:opacity`}
                    onCheckedChange={(checked) => handleChange('opacity', checked ? (element.opacity || '100%') : '100%')}
                    disabled={isReadonly}
                  >
                    <div className="pt-1 pb-2">
                      <UnderlineTextInput label="" value={element.opacity ?? '100%'} onChange={(v) => handleChange('opacity', v)} disabled={isReadonly} />
                    </div>
                  </ScratchToggleRow>
                </div>
                
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Z-Index"
                    defaultChecked={element.z_index !== undefined && element.z_index !== 0}
                    resetKey={`${element.id}:zindex`}
                    onCheckedChange={(checked) => handleChange('z_index', checked ? (element.z_index || 0) : 0)}
                    disabled={isReadonly}
                  >
                    <div className="pt-1 pb-2">
                      <UnderlineTextInput label="" value={element.z_index ?? 0} onChange={(v) => handleChange('z_index', parseInt(v))} disabled={isReadonly} />
                    </div>
                  </ScratchToggleRow>
                </div>

                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Padding"
                    defaultChecked={element.padding !== undefined && element.padding !== '0vmin'}
                    resetKey={`${element.id}:padding`}
                    onCheckedChange={(checked) => handleChange('padding', checked ? (element.padding || '0vmin') : '0vmin')}
                    disabled={isReadonly}
                  >
                    <div className="pt-1 pb-2">
                      <UnderlineTextInput label="" value={element.padding ?? '0vmin'} onChange={(v) => handleChange('padding', v)} disabled={isReadonly} />
                    </div>
                  </ScratchToggleRow>
                </div>

                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Corners"
                    defaultChecked={element.border_radius !== undefined && element.border_radius !== '0vmin'}
                    resetKey={`${element.id}:corners`}
                    onCheckedChange={(checked) => handleChange('border_radius', checked ? (element.border_radius || '0vmin') : '0vmin')}
                    disabled={isReadonly}
                  >
                    <div className="pt-1 pb-2">
                      <UnderlineTextInput label="" value={element.border_radius ?? '0vmin'} onChange={(v) => handleChange('border_radius', v)} disabled={isReadonly} />
                    </div>
                  </ScratchToggleRow>
                </div>
            </div>

            {/* --- EFFECTS (FLATTENED) --- */}
            <div className="space-y-0">
                {/* Blur */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                      label="Blur"
                      defaultChecked={Boolean(element.blur_radius) && element.blur_radius !== 0}
                      resetKey={`${element.id}:blur`}
                      onCheckedChange={(checked) => handleChange('blur_radius', checked ? (element.blur_radius || '1vmin') : 0)}
                      disabled={isReadonly}
                  >
                      <div className="pt-1 pb-2">
                        <UnderlineTextInput label="Radius" value={element.blur_radius ?? '1vmin'} onChange={(v) => handleChange('blur_radius', v)} disabled={isReadonly} />
                      </div>
                  </ScratchToggleRow>
                </div>

                {/* Color Filter */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                      label="Color Filter"
                      defaultChecked={Boolean(element.color_filter) && element.color_filter !== 'none'}
                      resetKey={`${element.id}:filter`}
                      onCheckedChange={(checked) => handleChange('color_filter', checked ? 'brighten' : 'none')}
                      disabled={isReadonly}
                  >
                      <div className="space-y-3 pt-1 pb-2">
                        <UnderlineSelect 
                            label="Type" 
                            value={element.color_filter || 'none'} 
                            onChange={(v) => handleChange('color_filter', v)}
                            options={['none','brighten','contrast','grayscale','hue','invert','sepia'].map(f => ({ label: f.charAt(0).toUpperCase() + f.slice(1), value: f }))}
                            disabled={isReadonly}
                        />
                        <UnderlineTextInput label="Value" value={element.color_filter_value ?? '0'} onChange={(v) => handleChange('color_filter_value', v)} disabled={isReadonly} />
                      </div>
                  </ScratchToggleRow>
                </div>

                {/* Color Overlay */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                      label="Color Overlay"
                      defaultChecked={Boolean(element.color_overlay)}
                      resetKey={`${element.id}:overlay`}
                      onCheckedChange={(checked) => handleChange('color_overlay', checked ? (element.color_overlay || '#ff0000') : '')}
                      disabled={isReadonly}
                  >
                      <div className="pt-1 pb-2">
                        <ColorRowLite title="Color" value={element.color_overlay || '#ff0000'} onChange={(v) => handleChange('color_overlay', v)} disabled={isReadonly} />
                      </div>
                  </ScratchToggleRow>
                </div>

                {/* Chroma Key */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                      label="Chroma Key"
                      defaultChecked={Boolean(element.chroma_key_color)}
                      resetKey={`${element.id}:chroma`}
                      onCheckedChange={(checked) => handleChange('chroma_key_color', checked ? (element.chroma_key_color || '#00ff00') : '')}
                      disabled={isReadonly}
                  >
                      <div className="space-y-3 pt-1 pb-2">
                        <ColorRowLite title="Key Color" value={element.chroma_key_color || '#00ff00'} onChange={(v) => handleChange('chroma_key_color', v)} disabled={isReadonly} />
                        <UnderlineTextInput label="Threshold" value={element.chroma_key_threshold ?? '10%'} onChange={(v) => handleChange('chroma_key_threshold', v)} disabled={isReadonly} />
                      </div>
                  </ScratchToggleRow>
                </div>

                {/* Blend Mode */}
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Blend Mode"
                    defaultChecked={Boolean(element.blend_mode) && element.blend_mode !== 'none'}
                    resetKey={`${element.id}:blend`}
                    onCheckedChange={(checked) => handleChange('blend_mode', checked ? (element.blend_mode && element.blend_mode !== 'none' ? element.blend_mode : 'multiply') : 'none')}
                    disabled={isReadonly}
                  >
                    <div className="pt-1 pb-2">
                      <UnderlineSelect 
                          label="Mode" 
                          value={element.blend_mode && element.blend_mode !== 'none' ? element.blend_mode : 'multiply'} 
                          onChange={(v) => handleChange('blend_mode', v)}
                          options={['multiply','screen','overlay','darken','lighten','lighter','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity'].map(b => ({ label: b.charAt(0).toUpperCase() + b.slice(1), value: b }))}
                          disabled={isReadonly}
                      />
                    </div>
                  </ScratchToggleRow>
                </div>
            </div>

            {/* --- MASK & WARP (FLATTENED) --- */}
            <div className="space-y-0">
                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Mask"
                    defaultChecked={Boolean(element.mask_mode) && element.mask_mode !== 'none'}
                    resetKey={`${element.id}:mask`}
                    onCheckedChange={(checked) => handleChange('mask_mode', checked ? 'alpha' : 'none')}
                    disabled={isReadonly}
                  >
                    <div className="pt-1 pb-2">
                      <UnderlineSelect 
                        label="Mode" 
                        value={element.mask_mode || 'none'} 
                        onChange={(v) => handleChange('mask_mode', v)}
                        options={[{ label: 'None', value: 'none' }, { label: 'Alpha', value: 'alpha' }, { label: 'Inverted Alpha', value: 'inverted-alpha' }, { label: 'Luma', value: 'luma' }, { label: 'Inverted Luma', value: 'inverted-luma' }]}
                        disabled={isReadonly}
                      />
                    </div>
                  </ScratchToggleRow>
                </div>

                <div className="px-3 border-b border-border/30">
                  <ScratchToggleRow
                    label="Warp"
                    defaultChecked={Boolean(element.warp_mode) && element.warp_mode !== 'none'}
                    resetKey={`${element.id}:warp`}
                    onCheckedChange={(checked) => handleChange('warp_mode', checked ? 'arc' : 'none')}
                    disabled={isReadonly}
                  >
                    <div className="space-y-3 pt-1 pb-2">
                      <UnderlineSelect 
                        label="Mode" 
                        value={element.warp_mode || 'none'} 
                        onChange={(v) => handleChange('warp_mode', v)}
                        options={[{ label: 'None', value: 'none' }, { label: 'Arc', value: 'arc' }, { label: 'Wave', value: 'wave' }, { label: 'Flag', value: 'flag' }, { label: 'Fish Eye', value: 'fish-eye' }]}
                        disabled={isReadonly}
                      />
                      <UnderlineTextInput label="Amount" value={element.warp_amount ?? '50%'} onChange={(v) => handleChange('warp_amount', v)} disabled={isReadonly} />
                    </div>
                  </ScratchToggleRow>
                </div>
            </div>
          </div>
        ) : (
          <div className="p-4 text-[10px] text-muted-foreground italic text-center">
            Animation settings coming soon.
          </div>
        )}
      </div>
    </div>
  );
}

// Helper icons
function AlignLeftIcon() { return <svg width="16" height="16" viewBox="0 0 24 18" fill="currentColor"><path d="M3,2l18,0l0,2l-18,0l0,-2m0,4l12,0l0,2l-12,0l0,-2m0,4l18,0l0,2l-18,0l0,-2m0,4l12,0l0,2l-12,0l0,-2"></path></svg>; }
