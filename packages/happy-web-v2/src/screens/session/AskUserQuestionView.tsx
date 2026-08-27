/**
 * AskUserQuestionOptions — shared interactive option list for the
 * AskUserQuestion tool (B-100), used by both the transcript ToolView and the
 * PermissionCard. Clicking an option submits an answers map keyed by the exact
 * question text; callers inject it into the pending tool's updatedInput.
 * Input parsing happens at the CALL SITES via the knownTools zod schema — this
 * component receives already-validated questions.
 */
import { useState } from 'react';
import { Check, CheckSquare, MessageCircle, Square } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from '@/ui';
import {
    areQuestionAnswersComplete,
    buildQuestionAnswers,
    setQuestionAnswer,
    toggleLabel,
    type AskAnswerPayload,
    type AskAnswers,
    type AskQuestion,
} from './askUserQuestion';

function QuestionBlock({
    q,
    disabled,
    selected,
    picked,
    deferSubmit,
    onChange,
    onSubmit,
}: {
    q: AskQuestion;
    disabled: boolean;
    selected: string[];
    picked: string[];
    deferSubmit: boolean;
    onChange: (labels: string[]) => void;
    onSubmit: (labels: string[]) => void;
}) {
    const { t } = useTranslation();
    const [showOther, setShowOther] = useState(false);
    const [otherText, setOtherText] = useState('');
    const options = (q.options ?? []).filter(
        (o): o is { label: string; description?: string } => typeof o.label === 'string' && o.label !== '',
    );
    const multi = q.multiSelect === true;
    return (
        <div className="tv-ask-q">
            {(q.header || q.question) && (
                <div className="tv-ask-head">
                    {q.header && <span className="tv-ask-chip">{q.header}</span>}
                    {q.question && <span className="tv-ask-question">{q.question}</span>}
                </div>
            )}
            <div className="tv-ask-options" role="group">
                {options.map((o, i) => {
                    const isSelected = selected.includes(o.label);
                    const isPicked = picked.includes(o.label);
                    return (
                        <button
                            key={i}
                            type="button"
                            className={`tv-ask-opt${isSelected || isPicked ? ' tv-ask-opt--selected' : ''}`}
                            disabled={disabled}
                            aria-pressed={multi || deferSubmit ? isPicked : undefined}
                            onClick={() => {
                                if (multi) onChange(toggleLabel(picked, o.label));
                                else if (deferSubmit) onChange([o.label]);
                                else {
                                    onChange([o.label]);
                                    onSubmit([o.label]);
                                }
                            }}
                        >
                            <span className="tv-ask-opt-label">
                                {multi ? (
                                    isPicked ? <CheckSquare size={13} /> : <Square size={13} />
                                ) : isSelected || isPicked ? (
                                    <Check size={13} />
                                ) : null}
                                {o.label}
                            </span>
                            {o.description && <span className="tv-ask-opt-desc">{o.description}</span>}
                        </button>
                    );
                })}
                <button
                    type="button"
                    className={`tv-ask-opt tv-ask-opt--other${showOther ? ' tv-ask-opt--selected' : ''}`}
                    disabled={disabled}
                    aria-expanded={showOther}
                    onClick={() => setShowOther((current) => !current)}
                >
                    <span className="tv-ask-opt-label">
                        <MessageCircle size={13} />
                        {t('tools.askUserQuestion.other')}
                    </span>
                    <span className="tv-ask-opt-desc">{t('tools.askUserQuestion.otherDescription')}</span>
                </button>
            </div>
            {showOther && !disabled && (
                <div className="tv-ask-other">
                    <textarea
                        value={otherText}
                        rows={3}
                        autoFocus
                        placeholder={t('tools.askUserQuestion.otherPlaceholder')}
                        onChange={(event) => {
                            const value = event.target.value;
                            setOtherText(value);
                            if (deferSubmit) onChange(value.trim() ? [value.trim()] : []);
                        }}
                    />
                    {!deferSubmit && (
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={!otherText.trim()}
                            onClick={() => {
                                const answer = otherText.trim();
                                onChange([answer]);
                                onSubmit([answer]);
                            }}
                        >
                            {t('tools.askUserQuestion.submit')}
                        </Button>
                    )}
                </div>
            )}
            {multi && !deferSubmit && !disabled && (
                <Button
                    size="sm"
                    variant="primary"
                    disabled={picked.length === 0}
                    onClick={() => onSubmit(picked)}
                >
                    {t('tools.askUserQuestion.submit')}
                </Button>
            )}
        </div>
    );
}

export function AskUserQuestionOptions({
    questions,
    disabled,
    selected,
    onSubmit,
}: {
    questions: AskQuestion[];
    /** Already answered / submission in flight — options render inert. */
    disabled: boolean;
    /** Labels detected as chosen in the tool result (highlight only). */
    selected?: string[];
    onSubmit: (answers: AskAnswerPayload) => void;
}) {
    const { t } = useTranslation();
    const [answers, setAnswers] = useState<AskAnswers>({});
    const batched = questions.length > 1;
    const complete = areQuestionAnswersComplete(questions, answers);
    return (
        <div className="tv-ask">
            {questions.map((q, i) => (
                <QuestionBlock
                    key={i}
                    q={q}
                    disabled={disabled}
                    selected={selected ?? []}
                    picked={answers[i] ?? []}
                    deferSubmit={batched}
                    onChange={(labels) => setAnswers((current) => setQuestionAnswer(current, i, labels))}
                    onSubmit={(labels) =>
                        onSubmit(buildQuestionAnswers(questions, setQuestionAnswer({}, i, labels)))
                    }
                />
            ))}
            {batched && !disabled && (
                <Button
                    size="sm"
                    variant="primary"
                    disabled={!complete}
                    onClick={() => onSubmit(buildQuestionAnswers(questions, answers))}
                >
                    {t('tools.askUserQuestion.submit')}
                </Button>
            )}
        </div>
    );
}
