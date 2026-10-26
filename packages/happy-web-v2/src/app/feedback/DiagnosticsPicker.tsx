import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Checkbox } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import type { FeedbackDiagnostics } from './feedbackPolicy';

/**
 * B-836: 附带诊断信息 (on by default) plus the exact JSON that will be sent.
 * What is shown here is the object passed to the API — nothing is added later.
 */
export function DiagnosticsPicker({ diagnostics, included, onIncludedChange }: {
  diagnostics: FeedbackDiagnostics;
  included: boolean;
  onIncludedChange: (included: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="fb-diag">
      <Checkbox checked={included} onCheckedChange={onIncludedChange} className="fb-diag-check">
        <span className="fb-diag-label">{t('feedback.includeDiagnostics')}</span>
      </Checkbox>
      <p className="fb-diag-hint">{t('feedback.diagnosticsHint')}</p>
      <button type="button" className="fb-diag-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        <ChevronDown size={14} aria-hidden="true" className="fb-diag-chevron" />
        {open ? t('feedback.hideDiagnostics') : t('feedback.showDiagnostics')}
      </button>
      {open && <pre id={panelId} className="fb-diag-json mono" data-included={included}>{JSON.stringify(diagnostics, null, 2)}</pre>}
    </div>
  );
}
