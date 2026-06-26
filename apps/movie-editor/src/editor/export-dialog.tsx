
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Mail, AlertCircle } from 'lucide-react';
import { toast } from '@/lib/toast';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playbookId: string;
  videoProjectId: string;
  source: any;
}

export function ExportDialog({
  open,
  onOpenChange,
  playbookId,
  videoProjectId,
  source,
}: ExportDialogProps) {
  const [format, setFormat] = useState<'mp4' | 'jpg' | 'png'>('mp4');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'queued' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [deliveryEmail, setDeliveryEmail] = useState<string | null>(null);

  const reset = () => {
    setStatus('idle');
    setError(null);
    setDeliveryEmail(null);
  };

  useEffect(() => {
    if (!open) {
      if (status !== 'submitting') {
        reset();
      }
    }
  }, [open, status]);

  const handleExport = async () => {
    setStatus('submitting');
    setError(null);

    try {
      const response = await fetch(
        `/api/playbooks/${playbookId}/video/${videoProjectId}/export`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format, source }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to start export');
      }

      const data = await response.json();
      setDeliveryEmail(data.email || null);
      setStatus('queued');
      toast.success('Export started. We will email you the link when it is ready.');
    } catch (err: any) {
      setError(err.message);
      setStatus('failed');
      toast.error(err.message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Export Project</DialogTitle>
          <DialogDescription>
            Render your project into a high-quality video or image.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {status === 'idle' && (
            <div className="grid gap-2">
              <label className="text-sm font-medium">Output Format</label>
              <Select value={format} onValueChange={(v: any) => setFormat(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select format" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mp4">Video (MP4)</SelectItem>
                  <SelectItem value="jpg">Image (JPG)</SelectItem>
                  <SelectItem value="png">Image (PNG)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {status === 'submitting' && (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <div className="text-center">
                <p className="text-sm font-medium">Starting your export...</p>
                <p className="text-xs text-muted-foreground mt-1">
                  We are sending the render job to Creatomate.
                </p>
              </div>
            </div>
          )}

          {status === 'queued' && (
            <div className="flex flex-col items-center justify-center py-6 gap-4">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <Mail className="h-6 w-6 text-green-600" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">We will email your export</p>
                <p className="text-xs text-muted-foreground mt-1">
                  The render is running in the background. You can close this dialog.
                </p>
                {deliveryEmail ? (
                  <p className="text-xs text-muted-foreground mt-2">
                    Delivery address: <span className="font-medium text-foreground">{deliveryEmail}</span>
                  </p>
                ) : null}
              </div>
              <Button className="w-full mt-2" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          )}

          {status === 'failed' && (
            <div className="flex flex-col items-center justify-center py-6 gap-4">
              <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-destructive">Export Failed</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {error || 'An unexpected error occurred during rendering.'}
                </p>
              </div>
              <Button onClick={() => setStatus('idle')} className="w-full mt-2">
                Try Again
              </Button>
            </div>
          )}
        </div>

        {status === 'idle' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleExport}>
              Start Export
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

