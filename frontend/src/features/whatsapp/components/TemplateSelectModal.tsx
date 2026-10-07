import React, { useState, useEffect, useMemo } from 'react';
import {
  LayoutTemplate,
  Send,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Plus,
  Edit2,
  Trash2,
  Search,
  ArrowLeft,
  CornerDownLeft,
  MessageSquare,
} from 'lucide-react';
import { QuickReply, QuickReplyCreateRequest, QuickReplyUpdateRequest } from '../../../types';
import { WhatsAppRepository } from '../data/whatsappRepository';
import { translateApiError } from '../lib/translateError';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/button';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';

export interface TemplateSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  leadName?: string;
  onSelectTemplate?: (renderedText: string) => void;
  onSendTemplate?: (templateKey: string, variables: Record<string, string>) => Promise<void>;
}

export const TemplateSelectModal: React.FC<TemplateSelectModalProps> = ({
  isOpen,
  onClose,
  leadName = '',
  onSelectTemplate,
  onSendTemplate,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filter & Search
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

  // Selected quick reply for insertion/preview
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<boolean>(false);

  // Form mode: 'LIST' | 'CREATE' | 'EDIT'
  const [formMode, setFormMode] = useState<'LIST' | 'CREATE' | 'EDIT'>('LIST');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formShortcut, setFormShortcut] = useState<string>('');
  const [formTitle, setFormTitle] = useState<string>('');
  const [formContent, setFormContent] = useState<string>('');
  const [formCategory, setFormCategory] = useState<string>('GENEL');
  const [saving, setSaving] = useState<boolean>(false);

  const fetchQuickReplies = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await WhatsAppRepository.getQuickReplies();
      setQuickReplies(data);
      if (data.length > 0 && selectedId === null) {
        setSelectedId(data[0].id);
        initVariables(data[0], leadName);
      }
    } catch (err: any) {
      console.error('[TemplateSelectModal] Failed to load quick replies:', err);
      setLoadError(
        translateApiError(err, t) || t('whatsapp.templatesNotAvailable'),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setFormMode('LIST');
      setSearchQuery('');
      setSelectedCategory('ALL');
      void fetchQuickReplies();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, leadName]);

  const initVariables = (qr: QuickReply, name: string) => {
    const initial: Record<string, string> = {};
    const safeName = (name || '').trim();
    if (qr.variables && qr.variables.length > 0) {
      for (const v of qr.variables) {
        if (v.default_from === 'lead_name') {
          initial[v.key] = safeName;
        } else {
          initial[v.key] = v.default_value || '';
        }
      }
    } else {
      initial['isim'] = safeName;
    }
    setVariables(initial);
  };

  const selectedQr = useMemo(() => {
    return quickReplies.find((qr) => qr.id === selectedId) || null;
  }, [quickReplies, selectedId]);

  const handleSelectQuickReply = (qr: QuickReply) => {
    setSelectedId(qr.id);
    initVariables(qr, leadName);
  };

  // Distinct categories
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const qr of quickReplies) {
      if (qr.category) cats.add(qr.category.trim());
    }
    return Array.from(cats);
  }, [quickReplies]);

  // Filtered list
  const filteredQuickReplies = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return quickReplies.filter((qr) => {
      const matchesCategory =
        selectedCategory === 'ALL' ||
        (qr.category || '').toLowerCase() === selectedCategory.toLowerCase();
      if (!matchesCategory) return false;
      if (!q) return true;
      return (
        qr.title.toLowerCase().includes(q) ||
        qr.shortcut.toLowerCase().includes(q) ||
        qr.content.toLowerCase().includes(q)
      );
    });
  }, [quickReplies, selectedCategory, searchQuery]);

  const getRenderedContent = (qr: QuickReply | null) => {
    if (!qr) return '';
    let rendered = qr.content;
    const safeLeadName = (leadName || '').trim();
    if (qr.variables && qr.variables.length > 0) {
      for (const v of qr.variables) {
        const val =
          variables[v.key] !== undefined
            ? variables[v.key]
            : v.default_from === 'lead_name'
            ? safeLeadName
            : v.default_value || '';
        rendered = rendered.replace(new RegExp(`\\{${v.key}\\}`, 'g'), val);
      }
    } else {
      rendered = rendered.replace(/\{isim\}/g, safeLeadName);
    }
    return rendered;
  };

  const handleInsert = () => {
    if (!selectedQr) return;
    const rendered = getRenderedContent(selectedQr);
    if (onSelectTemplate) {
      onSelectTemplate(rendered);
      onClose();
    } else if (onSendTemplate) {
      void handleDirectSend();
    }
  };

  const handleDirectSend = async () => {
    if (!selectedQr || sending) return;
    setSending(true);
    try {
      if (onSendTemplate) {
        await onSendTemplate(selectedQr.shortcut, variables);
      } else if (onSelectTemplate) {
        onSelectTemplate(getRenderedContent(selectedQr));
      }
      onClose();
    } catch (err) {
      console.error('[TemplateSelectModal] Direct send failed:', err);
    } finally {
      setSending(false);
    }
  };

  // Form handling
  const handleOpenCreate = () => {
    setFormMode('CREATE');
    setEditingId(null);
    setFormShortcut('');
    setFormTitle('');
    setFormContent('');
    setFormCategory('GENEL');
  };

  const handleOpenEdit = (qr: QuickReply, e: React.MouseEvent) => {
    e.stopPropagation();
    setFormMode('EDIT');
    setEditingId(qr.id);
    setFormShortcut(qr.shortcut);
    setFormTitle(qr.title);
    setFormContent(qr.content);
    setFormCategory(qr.category || 'GENEL');
  };

  const handleDelete = async (qr: QuickReply, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await toast.confirm({
      title: t('whatsapp.deleteQuickReply'),
      message: t('whatsapp.deleteQuickReplyConfirm'),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await WhatsAppRepository.deleteQuickReply(qr.id);
      toast.success(t('whatsapp.quickReplyDeleted'), t('common.success'));
      setQuickReplies((prev) => prev.filter((item) => item.id !== qr.id));
      if (selectedId === qr.id) {
        const remaining = quickReplies.filter((item) => item.id !== qr.id);
        if (remaining.length > 0) {
          setSelectedId(remaining[0].id);
          initVariables(remaining[0], leadName);
        } else {
          setSelectedId(null);
        }
      }
    } catch (err: any) {
      toast.error(translateApiError(err, t) || t('common.error'), t('common.error'));
    }
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim() || !formContent.trim()) {
      toast.error(t('common.fillRequiredFields'), t('common.error'));
      return;
    }

    setSaving(true);
    try {
      if (formMode === 'CREATE') {
        const payload: QuickReplyCreateRequest = {
          title: formTitle.trim(),
          shortcut: formShortcut.trim() || undefined,
          content: formContent.trim(),
          category: formCategory.trim() || undefined,
        };
        const created = await WhatsAppRepository.createQuickReply(payload);
        toast.success(t('whatsapp.quickReplySaved'), t('common.success'));
        setQuickReplies((prev) => [created, ...prev]);
        setSelectedId(created.id);
        initVariables(created, leadName);
      } else if (formMode === 'EDIT' && editingId !== null) {
        const payload: QuickReplyUpdateRequest = {
          title: formTitle.trim(),
          shortcut: formShortcut.trim() || undefined,
          content: formContent.trim(),
          category: formCategory.trim() || undefined,
        };
        const updated = await WhatsAppRepository.updateQuickReply(editingId, payload);
        toast.success(t('whatsapp.quickReplySaved'), t('common.success'));
        setQuickReplies((prev) =>
          prev.map((item) => (item.id === editingId ? updated : item)),
        );
        if (selectedId === editingId) {
          initVariables(updated, leadName);
        }
      }
      setFormMode('LIST');
    } catch (err: any) {
      toast.error(translateApiError(err, t) || t('common.error'), t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        formMode === 'CREATE'
          ? t('whatsapp.newQuickReply')
          : formMode === 'EDIT'
          ? t('whatsapp.editQuickReply')
          : t('whatsapp.quickRepliesTitle')
      }
      subtitle={
        formMode !== 'LIST'
          ? undefined
          : t('whatsapp.quickRepliesDesc')
      }
      icon={LayoutTemplate}
      maxWidth="2xl"
    >
      {loading ? (
        <div className="flex items-center justify-center p-12 space-x-2 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin text-[#7367F0]" />
          <span className="text-xs font-bold">{t('common.loading')}</span>
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center p-10 space-y-3 text-center">
          <AlertTriangle className="w-8 h-8 text-[#EA5455]" />
          <p className="text-xs font-bold text-slate-700 dark:text-slate-200">{loadError}</p>
          <div className="flex items-center space-x-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={fetchQuickReplies}
              className="text-xs font-bold"
            >
              {t('common.retry')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              className="text-xs font-bold"
            >
              {t('common.close')}
            </Button>
          </div>
        </div>
      ) : formMode !== 'LIST' ? (
        /* CREATE / EDIT FORM VIEW */
        <form onSubmit={handleSaveForm} className="space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-200/80 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={() => setFormMode('LIST')}
              className="flex items-center space-x-1.5 text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>{t('common.back')}</span>
            </button>
            <span className="text-[11px] font-semibold text-slate-400">
              {t('whatsapp.quickReplyVariablesHelp')}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('whatsapp.quickReplyTitle')} *
              </label>
              <input
                type="text"
                required
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Örn: Fiyat Bilgisi"
                className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('whatsapp.quickReplyShortcut')}
              </label>
              <input
                type="text"
                value={formShortcut}
                onChange={(e) => setFormShortcut(e.target.value)}
                placeholder="/fiyat"
                className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-mono font-medium"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
              {t('whatsapp.quickReplyCategory')}
            </label>
            <input
              type="text"
              value={formCategory}
              onChange={(e) => setFormCategory(e.target.value)}
              placeholder="GENEL, SATIS, DESTEK..."
              className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
              {t('whatsapp.quickReplyContent')} *
            </label>
            <textarea
              required
              rows={4}
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              placeholder="Merhaba {isim}, fiyat bilgimizi aşağıda paylaşıyorum..."
              className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium resize-none leading-relaxed"
            />
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200/80 dark:border-white/[0.08]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFormMode('LIST')}
              disabled={saving}
              className="text-xs font-bold"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold space-x-1.5 shadow-sm cursor-pointer"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{t('common.save')}</span>
            </Button>
          </div>
        </form>
      ) : (
        /* MAIN LIST & SELECTION VIEW */
        <div className="space-y-4">
          {/* Top Control Bar: Search + Category Filter + Add New Button */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('whatsapp.quickReplySearchPlaceholder')}
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl vuexy-input font-medium"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleOpenCreate}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold space-x-1.5 shadow-xs shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('whatsapp.newQuickReply')}</span>
            </Button>
          </div>

          {/* Category Pills */}
          {categories.length > 0 && (
            <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 scrollbar-none text-[11px]">
              <button
                type="button"
                onClick={() => setSelectedCategory('ALL')}
                className={`px-2.5 py-1 rounded-lg font-bold transition-all cursor-pointer ${
                  selectedCategory === 'ALL'
                    ? 'bg-[#7367F0] text-white shadow-xs'
                    : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/[0.1]'
                }`}
              >
                {t('whatsapp.categoryAll')}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-2.5 py-1 rounded-lg font-bold uppercase transition-all cursor-pointer ${
                    selectedCategory === cat
                      ? 'bg-[#7367F0] text-white shadow-xs'
                      : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          {/* Quick Reply Selection Grid */}
          {filteredQuickReplies.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center space-y-2 rounded-xl bg-slate-50/50 dark:bg-white/[0.02] border border-dashed border-slate-200 dark:border-white/[0.08]">
              <MessageSquare className="w-6 h-6 text-slate-400" />
              <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                {t('whatsapp.noQuickReplies')}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-xs">
                {t('whatsapp.noQuickRepliesDesc')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[220px] overflow-y-auto pr-1">
              {filteredQuickReplies.map((qr) => {
                const isSelected = qr.id === selectedId;
                return (
                  <div
                    key={qr.id}
                    onClick={() => handleSelectQuickReply(qr)}
                    className={`group relative p-3 rounded-xl border transition-all cursor-pointer select-none flex flex-col justify-between ${
                      isSelected
                        ? 'bg-[#7367F0]/10 border-[#7367F0] shadow-xs'
                        : 'bg-slate-50/50 dark:bg-white/[0.03] border-slate-200/80 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/20'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between space-x-2">
                        <div className="flex items-center space-x-1.5 min-w-0">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#7367F0]/15 text-[#7367F0] shrink-0">
                            {qr.shortcut}
                          </span>
                          <h4 className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                            {qr.title}
                          </h4>
                        </div>
                        <div className="flex items-center space-x-1 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => handleOpenEdit(qr, e)}
                            className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
                            title={t('whatsapp.editQuickReply')}
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDelete(qr, e)}
                            className="p-1 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
                            title={t('whatsapp.deleteQuickReply')}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                          {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-[#7367F0] ml-1" />}
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                        {qr.content}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Variable Inputs (if selected quick reply has custom variables) */}
          {selectedQr && selectedQr.variables && selectedQr.variables.length > 0 && (
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-black/20 border border-slate-200/80 dark:border-white/[0.06] space-y-2.5">
              <h5 className="text-[11px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">
                {t('whatsapp.templateVariables')}
              </h5>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {selectedQr.variables.map((v) => (
                  <div key={v.key} className="space-y-1">
                    <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                      {v.label}
                    </label>
                    <input
                      type="text"
                      value={variables[v.key] || ''}
                      onChange={(e) =>
                        setVariables((prev) => ({ ...prev, [v.key]: e.target.value }))
                      }
                      placeholder={v.label}
                      className="w-full px-3 py-1.5 text-xs rounded-xl vuexy-input font-medium"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Real-time Message Preview Box */}
          {selectedQr && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">
                {t('whatsapp.messagePreview')}
              </label>
              <div className="p-3 rounded-xl bg-[#25D366]/10 dark:bg-[#25D366]/15 border border-[#25D366]/25 text-slate-800 dark:text-slate-100 text-xs leading-relaxed font-medium">
                <p className="whitespace-pre-wrap">{getRenderedContent(selectedQr)}</p>
              </div>
            </div>
          )}

          {/* Actions: "Mesaja Ekle" (Primary) + Cancel */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200/80 dark:border-white/[0.08]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={sending}
              className="text-xs font-bold"
            >
              {t('common.cancel')}
            </Button>
            <div className="flex items-center space-x-2">
              {onSendTemplate && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDirectSend}
                  disabled={sending || !selectedQr}
                  className="text-xs font-bold space-x-1.5 cursor-pointer"
                >
                  {sending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  <span>{t('whatsapp.sendTemplateBtn')}</span>
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={handleInsert}
                disabled={sending || !selectedQr}
                className="bg-[#25D366] hover:bg-[#1EBE5D] text-white text-xs font-bold space-x-1.5 shadow-sm cursor-pointer"
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
                <span>{t('whatsapp.insertIntoChat')}</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
