import React, { useState, useRef, useCallback } from 'react';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  FileText,
  Sparkles,
  Building2,
  Phone,
  MapPin,
  Tag,
  Globe,
  RotateCcw,
} from 'lucide-react';
import { Modal, Button, Badge } from '../../../components/ui';
import { ApiClient } from '../../../api/client';
import { LeadImportPreviewResult, LeadImportResult } from '../../../types';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { cn } from '../../../lib/utils';

export interface LeadImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type ImportStep = 'UPLOAD' | 'MAP' | 'IMPORTING' | 'SUMMARY';

export const LeadImportModal: React.FC<LeadImportModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [step, setStep] = useState<ImportStep>('UPLOAD');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [importing, setImporting] = useState(false);
  const [previewData, setPreviewData] = useState<LeadImportPreviewResult | null>(null);
  const [importResult, setImportResult] = useState<LeadImportResult | null>(null);

  // Column Mapping state
  const [mapping, setMapping] = useState<Record<string, string>>({
    name: '',
    phone: '',
    city: '',
    district: '',
    category: '',
    website: '',
    address: '',
    notes: '',
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setStep('UPLOAD');
    setSelectedFile(null);
    setIsDragging(false);
    setLoadingPreview(false);
    setImporting(false);
    setPreviewData(null);
    setImportResult(null);
    setMapping({
      name: '',
      phone: '',
      city: '',
      district: '',
      category: '',
      website: '',
      address: '',
      notes: '',
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleClose = () => {
    if (importing) return;
    resetState();
    onClose();
  };

  const handleProcessFile = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) {
      toast.error('Lütfen geçerli bir Excel (.xlsx, .xls) veya CSV (.csv, .tsv) dosyası seçin.');
      return;
    }

    setSelectedFile(file);
    setLoadingPreview(true);

    try {
      const data = await ApiClient.previewImportLeads(file);
      setPreviewData(data);

      // Initialize mapping with detected mappings
      setMapping({
        name: data.detected_mapping?.name || '',
        phone: data.detected_mapping?.phone || '',
        city: data.detected_mapping?.city || '',
        district: data.detected_mapping?.district || '',
        category: data.detected_mapping?.category || '',
        website: data.detected_mapping?.website || '',
        address: data.detected_mapping?.address || '',
        notes: data.detected_mapping?.notes || '',
      });

      setStep('MAP');
    } catch (err: any) {
      toast.error(err.message || 'Dosya önizlemesi alınamadı.');
      setSelectedFile(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleProcessFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleProcessFile(e.target.files[0]);
    }
  };

  const handleExecuteImport = async () => {
    if (!selectedFile) return;

    if (!mapping.name) {
      toast.error('Lütfen İşletme Adı alanını eşleştirin.');
      return;
    }

    setImporting(true);
    setStep('IMPORTING');

    try {
      // Clean mapping dict (omit unmapped keys)
      const cleanMapping: Record<string, string> = {};
      Object.entries(mapping).forEach(([k, v]) => {
        if (v && v.trim()) {
          cleanMapping[k] = v.trim();
        }
      });

      const result = await ApiClient.importLeads(selectedFile, cleanMapping);
      setImportResult(result);
      setStep('SUMMARY');
      toast.success(t('leads.importSuccessTitle'));
    } catch (err: any) {
      toast.error(err.message || 'İçe aktarma sırasında hata oluştu.');
      setStep('MAP');
    } finally {
      setImporting(false);
    }
  };

  const handleComplete = () => {
    resetState();
    onSuccess();
    onClose();
  };

  const STANDARD_FIELDS = [
    { key: 'name', label: t('leads.colMapName'), icon: Building2, required: true },
    { key: 'phone', label: t('leads.colMapPhone'), icon: Phone, required: true },
    { key: 'city', label: t('leads.colMapCity'), icon: MapPin, required: false },
    { key: 'district', label: t('leads.colMapDistrict'), icon: MapPin, required: false },
    { key: 'category', label: t('leads.colMapCategory'), icon: Tag, required: false },
    { key: 'website', label: t('leads.colMapWebsite'), icon: Globe, required: false },
    { key: 'address', label: t('leads.colMapAddress'), icon: MapPin, required: false },
    { key: 'notes', label: t('leads.colMapNotes'), icon: FileText, required: false },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('leads.importModalTitle')}
      subtitle={t('leads.importModalSubtitle')}
      icon={Upload}
      variant="primary"
      maxWidth="2xl"
      footer={
        step === 'MAP' ? (
          <div className="flex items-center justify-between w-full">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setStep('UPLOAD');
                setSelectedFile(null);
              }}
              className="space-x-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Geri Dön</span>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!mapping.name}
              onClick={handleExecuteImport}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold space-x-1.5 shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              <span>{t('leads.startImportBtn')}</span>
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        ) : step === 'SUMMARY' ? (
          <div className="flex justify-end w-full">
            <Button
              type="button"
              size="sm"
              onClick={handleComplete}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold space-x-1.5 shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{t('leads.closeAndRefresh')}</span>
            </Button>
          </div>
        ) : null
      }
    >
      <div className="space-y-6">
        {/* Step Indicator Header */}
        <div className="grid grid-cols-3 gap-2 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
          <div
            className={cn(
              'flex items-center space-x-2 pb-1.5 border-b-2 text-xs font-bold transition-colors',
              step === 'UPLOAD'
                ? 'border-[#7367F0] text-[#7367F0]'
                : 'border-transparent text-slate-400'
            )}
          >
            <div className="w-5 h-5 rounded-full bg-[#7367F0]/10 flex items-center justify-center text-[11px]">
              1
            </div>
            <span className="truncate">{t('leads.stepSelectFile')}</span>
          </div>
          <div
            className={cn(
              'flex items-center space-x-2 pb-1.5 border-b-2 text-xs font-bold transition-colors',
              step === 'MAP' || step === 'IMPORTING'
                ? 'border-[#7367F0] text-[#7367F0]'
                : 'border-transparent text-slate-400'
            )}
          >
            <div className="w-5 h-5 rounded-full bg-[#7367F0]/10 flex items-center justify-center text-[11px]">
              2
            </div>
            <span className="truncate">{t('leads.stepMapColumns')}</span>
          </div>
          <div
            className={cn(
              'flex items-center space-x-2 pb-1.5 border-b-2 text-xs font-bold transition-colors',
              step === 'SUMMARY'
                ? 'border-[#7367F0] text-[#7367F0]'
                : 'border-transparent text-slate-400'
            )}
          >
            <div className="w-5 h-5 rounded-full bg-[#7367F0]/10 flex items-center justify-center text-[11px]">
              3
            </div>
            <span className="truncate">{t('leads.stepResults')}</span>
          </div>
        </div>

        {/* STEP 1: FILE SELECTION / DROPZONE */}
        {step === 'UPLOAD' && (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,.tsv"
              onChange={handleFileChange}
              className="hidden"
            />

            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center cursor-pointer transition-all duration-200 flex flex-col items-center justify-center',
                isDragging
                  ? 'border-[#7367F0] bg-[#7367F0]/5 scale-[0.99]'
                  : 'border-slate-200 dark:border-white/10 hover:border-[#7367F0]/50 hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
              )}
            >
              {loadingPreview ? (
                <div className="flex flex-col items-center space-y-3">
                  <Loader2 className="w-10 h-10 text-[#7367F0] animate-spin" />
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
                    Dosya analiz ediliyor ve sütunlar çözümleniyor...
                  </p>
                </div>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-2xl bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center mb-3 shadow-xs">
                    <FileSpreadsheet className="w-7 h-7" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-white mb-1">
                    {t('leads.dropzonePrompt')}
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mb-4">
                    {t('leads.dropzoneSupported')}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="space-x-1.5 font-bold cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Dosya Seç</span>
                  </Button>
                </>
              )}
            </div>

            {/* Hint Box */}
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] flex items-start space-x-3 text-xs text-slate-600 dark:text-slate-300">
              <Sparkles className="w-4 h-4 text-[#7367F0] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-bold text-slate-800 dark:text-white">Akıllı Sütun Eşleştirme</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Excel veya CSV dosyanızdaki sütun başlıkları (Firma Adı, Telefon, GSM, İlçe, Sektör vb.)
                  otomatik olarak algılanır. Bir sonraki adımda eşleştirmeleri dilediğiniz gibi kontrol edebilir veya değiştirebilirsiniz.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: COLUMN MAPPING & PREVIEW */}
        {step === 'MAP' && previewData && (
          <div className="space-y-5">
            {/* File Info Bar */}
            <div className="p-3 rounded-xl bg-[#7367F0]/10 border border-[#7367F0]/20 flex items-center justify-between text-xs">
              <div className="flex items-center space-x-2">
                <FileSpreadsheet className="w-4 h-4 text-[#7367F0]" />
                <span className="font-bold text-slate-800 dark:text-white">
                  {selectedFile?.name || previewData.filename}
                </span>
              </div>
              <Badge variant="primary" className="font-mono text-[10px]">
                {previewData.total_rows} Satır
              </Badge>
            </div>

            {/* Column Mapping Grid */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">
                  Sütun Eşleştirmeleri
                </h4>
                <span className="text-[11px] text-slate-400">
                  * Kırmızı işaretli alanlar zorunludur
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[260px] overflow-y-auto pr-1">
                {STANDARD_FIELDS.map((field) => {
                  const Icon = field.icon;
                  return (
                    <div
                      key={field.key}
                      className="p-3 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-slate-700 dark:text-slate-200 flex items-center space-x-1.5">
                          <Icon className="w-3.5 h-3.5 text-slate-400" />
                          <span>{field.label}</span>
                        </span>
                        {mapping[field.key] ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                        ) : field.required ? (
                          <AlertCircle className="w-3.5 h-3.5 text-rose-500" />
                        ) : null}
                      </div>

                      <select
                        value={mapping[field.key] || ''}
                        onChange={(e) =>
                          setMapping((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className={cn(
                          'w-full px-2.5 py-1.5 rounded-lg text-xs font-medium border bg-white dark:bg-[#1E2337] transition-colors',
                          mapping[field.key]
                            ? 'border-[#7367F0] text-slate-800 dark:text-white'
                            : field.required
                            ? 'border-rose-300 dark:border-rose-500/40 text-slate-400'
                            : 'border-slate-200 dark:border-white/10 text-slate-400'
                        )}
                      >
                        <option value="">{t('leads.selectColumnPlaceholder')}</option>
                        {previewData.headers.map((hdr) => (
                          <option key={hdr} value={hdr}>
                            {hdr}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Sample Table Preview (First 5 Rows) */}
            {previewData.preview_rows.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">
                  {t('leads.previewTableTitle')}
                </h4>
                <div className="overflow-x-auto rounded-xl border border-slate-200/60 dark:border-white/[0.06] max-h-44">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100/70 dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 font-bold sticky top-0">
                      <tr>
                        {previewData.headers.map((h) => (
                          <th key={h} className="px-3 py-2 whitespace-nowrap text-[11px]">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/[0.04] text-slate-700 dark:text-slate-300">
                      {previewData.preview_rows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50/50 dark:hover:bg-white/[0.02]">
                          {previewData.headers.map((h) => (
                            <td key={h} className="px-3 py-1.5 whitespace-nowrap text-[11px] truncate max-w-[160px]">
                              {row[h] || '-'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 3: IMPORTING STATE */}
        {step === 'IMPORTING' && (
          <div className="py-12 flex flex-col items-center justify-center text-center space-y-4">
            <Loader2 className="w-12 h-12 text-[#7367F0] animate-spin" />
            <div className="space-y-1">
              <h4 className="text-base font-bold text-slate-800 dark:text-white">
                {t('leads.importingInProgress')}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm">
                Telefon numaraları E.164 uluslararası formatına normalize ediliyor,
                kara liste taranıyor ve mükerrer kayıtlar filtreleniyor.
              </p>
            </div>
            <div className="w-64 h-1.5 bg-slate-100 dark:bg-white/10 rounded-full overflow-hidden">
              <div className="w-full h-full bg-[#7367F0] animate-pulse rounded-full" />
            </div>
          </div>
        )}

        {/* STEP 4: SUMMARY RESULTS */}
        {step === 'SUMMARY' && importResult && (
          <div className="space-y-6">
            <div className="flex flex-col items-center justify-center text-center space-y-2 pt-2">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center mb-1">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h3 className="text-base font-bold text-slate-800 dark:text-white">
                {t('leads.importSuccessTitle')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {selectedFile?.name} başarıyla ayrıştırıldı ve veritabanına aktarıldı.
              </p>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-center space-y-1">
                <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                  {t('leads.importTotalRows')}
                </p>
                <p className="text-lg font-bold font-mono text-slate-800 dark:text-white">
                  {importResult.total_rows}
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-center space-y-1">
                <p className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                  {t('leads.importCreatedCount')}
                </p>
                <p className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {importResult.created_count}
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-center space-y-1">
                <p className="text-[11px] font-bold text-blue-600 dark:text-blue-400">
                  {t('leads.importUpdatedCount')}
                </p>
                <p className="text-lg font-bold font-mono text-blue-600 dark:text-blue-400">
                  {importResult.updated_count}
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-center space-y-1">
                <p className="text-[11px] font-bold text-amber-600 dark:text-amber-400">
                  {t('leads.importInvalidPhones')}
                </p>
                <p className="text-lg font-bold font-mono text-amber-600 dark:text-amber-400">
                  {importResult.invalid_phone_count}
                </p>
              </div>
            </div>

            {importResult.skipped_count > 0 && (
              <div className="p-3 rounded-xl bg-slate-100 dark:bg-white/[0.04] text-xs text-slate-600 dark:text-slate-400 flex items-center justify-between">
                <span>{t('leads.importSkippedCount')} (İşletme adı bulunmayan):</span>
                <span className="font-bold font-mono">{importResult.skipped_count}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
