import { useId, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { ArrowUpOutlined, CloseOutlined, FilePdfOutlined, LoadingOutlined, PaperClipOutlined, PictureOutlined, PlusOutlined, SlidersOutlined } from '@ant-design/icons';
import { useI18n } from '../../shared/i18n';
import { Button, Drawer, Input, Popover, Tooltip } from '../../shared/ui';
import type { Attachment } from './types';

export type ComposerCommand = 'new' | 'history' | 'scope' | 'artifacts' | 'stop';
export type ComposerInput = ComponentRef<typeof Input.TextArea>;

interface ComposerProps {
  input: RefObject<ComposerInput | null>;
  text: string;
  onTextChange: (text: string) => void;
  attachments: Attachment[];
  attachmentError: string;
  readingAttachment: boolean;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  disabled: boolean;
  running: boolean;
  starting: boolean;
  onSend: () => void;
  onCommand: (command: ComposerCommand) => void;
  scope: ReactNode;
  scopeLabel: string;
  scopeInDrawer: boolean;
}

const attachmentTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export default function AssistantComposer({ input, text, onTextChange, attachments, attachmentError, readingAttachment, onAddFiles, onRemoveAttachment, disabled, running, starting, onSend, onCommand, scope, scopeLabel, scopeInDrawer }: ComposerProps) {
  const { t } = useI18n();
  const picker = useRef<HTMLInputElement>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const hintId = useId();
  const prefix = text.match(/^\/([a-z]*)$/i)?.[1]?.toLowerCase();
  const actions: { command: ComposerCommand; label: string }[] = [
    { command: 'new', label: t('新对话', 'New conversation') },
    { command: 'history', label: t('查找对话', 'Find a conversation') },
    { command: 'scope', label: t('设置分析范围', 'Set analysis scope') },
    { command: 'artifacts', label: t('查看产物', 'Show artifacts') },
  ];
  if (running) actions.push({ command: 'stop', label: t('停止当前响应', 'Stop current response') });
  const commands = prefix !== undefined && dismissed !== text && !disabled && !scopeOpen
    ? actions.filter(action => action.command.startsWith(prefix)) : [];
  const current = Math.min(cursor, commands.length - 1);
  const showCommands = commands.length > 0;
  const canSend = !disabled && !starting && !readingAttachment && Boolean(text.trim() || attachments.length);
  const canAttach = !disabled && !readingAttachment && attachments.length < 4;
  const submitLabel = running ? t('加入队列', 'Queue turn') : t('发送', 'Send');
  const scopeTitle = t('分析范围与设置', 'Analysis scope and settings');
  const scopeButton = <Button type="text" className="lm-assistant-scope-button" icon={<SlidersOutlined />} aria-label={scopeTitle}
    aria-expanded={scopeOpen} onClick={scopeInDrawer ? () => setScopeOpen(true) : undefined}><span>{scopeLabel}</span></Button>;

  function change(next: string) {
    setCursor(0);
    setDismissed('');
    onTextChange(next);
  }

  function execute(command: ComposerCommand) {
    change('');
    if (command === 'scope') setScopeOpen(true);
    else onCommand(command);
  }

  return <div className="lm-assistant-composer">
    <input ref={picker} type="file" className="lm-assistant-file-input" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" multiple aria-label={t('选择图片或 PDF', 'Choose images or PDFs')} onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      onAddFiles(files);
    }} />
    {!!attachments.length && <div className="lm-assistant-attachments">{attachments.map((attachment, index) =>
      <span className="lm-assistant-attachment" key={`${index}-${attachment.name}`}>
        {attachment.kind === 'pdf' ? <FilePdfOutlined aria-hidden="true" /> : <PictureOutlined aria-hidden="true" />}
        <span>{attachment.name}</span>
        <button type="button" aria-label={t(`移除 ${attachment.name}`, `Remove ${attachment.name}`)} onClick={() => onRemoveAttachment(index)}><CloseOutlined /></button>
      </span>
    )}</div>}
    <Input.TextArea
      ref={input}
      aria-label={t('给 AI 助手的问题', 'Question for the AI assistant')}
      aria-describedby={hintId}
      aria-controls={showCommands ? listId : undefined}
      aria-activedescendant={showCommands ? `${listId}-${current}` : undefined}
      aria-autocomplete="list"
      placeholder={t('输入问题，或键入 / 查看可用命令', 'Ask a question, or type / for commands')}
      value={text}
      onChange={event => change(event.target.value)}
      autoSize={{ minRows: 2, maxRows: 6 }}
      maxLength={16000}
      disabled={disabled}
      onPaste={event => {
        const files = Array.from(event.clipboardData.files).filter(file => attachmentTypes.has(file.type));
        if (!canAttach || !files.length) return;
        if (!event.clipboardData.getData('text/plain')) event.preventDefault();
        onAddFiles(files);
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (showCommands && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          setCursor((current + (event.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length);
        } else if (showCommands && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(text);
        } else if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          if (showCommands) execute(commands[current].command);
          else if (canSend) onSend();
        }
      }}
    />
    {showCommands && <div className="lm-assistant-commands" id={listId} role="listbox" aria-label={t('助手命令', 'Assistant commands')}>
      {commands.map(({ command, label }, index) => <div
        id={`${listId}-${index}`} key={command} role="option" aria-selected={index === current}
        onPointerMove={() => setCursor(index)} onMouseDown={event => event.preventDefault()} onClick={() => execute(command)}
      ><code>/{command}</code><span>{label}</span></div>)}
    </div>}
    {attachmentError && <div className="lm-assistant-attachment-error" role="alert">{attachmentError}</div>}
    <div className="lm-assistant-composer-actions">
      <div className="lm-assistant-composer-left">
        <Tooltip title={t('添加图片或 PDF', 'Attach image or PDF')}>
          <Button type="text" icon={readingAttachment ? <LoadingOutlined spin /> : <PaperClipOutlined />} aria-label={t('添加图片或 PDF', 'Attach image or PDF')} disabled={!canAttach} onClick={() => picker.current?.click()} />
        </Tooltip>
        {scopeInDrawer ? <>{scopeButton}<Drawer className="lm-assistant-scope-drawer" title={scopeTitle} open={scopeOpen}
          onClose={() => setScopeOpen(false)} size="min(378px, 100vw)" destroyOnHidden>{scope}</Drawer></>
          : <Popover open={scopeOpen} onOpenChange={setScopeOpen} content={scope} trigger="click" placement="top">{scopeButton}</Popover>}
      </div>
      <div className="lm-assistant-composer-send">
        <small id={hintId} className="lm-assistant-input-hint">{t('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line')}</small>
        <button type="button" className="lm-assistant-send-button" aria-label={submitLabel} title={submitLabel} disabled={!canSend} onClick={onSend}>
          {starting ? <LoadingOutlined spin /> : running ? <PlusOutlined /> : <ArrowUpOutlined />}
        </button>
      </div>
    </div>
  </div>;
}
