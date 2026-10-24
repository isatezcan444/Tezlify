import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Sparkles,
  Handshake,
  Search,
  Tag,
  Calendar,
  RefreshCw,
  CheckCircle2,
  Target,
  Users,
  ShieldCheck,
  Check,
  ArrowRight,
  ArrowLeft,
  MessageSquare,
  Clock,
  Lock,
  Info,
  Copy,
  Paperclip,
  Upload,
  FileText,
  Image as ImageIcon,
  Trash2,
  Loader2,
} from 'lucide-react';
import { ApiClient } from '../../../api/client';
import { CommunicationGoal } from '../../../types';
import { Button, Badge, Card } from '../../../components/ui';
import { FormField, TextInput, Textarea, FormSection } from '../../../components/forms';
import { SectorAutocomplete } from '../../leads/components';
import { SpintaxPreviewCard, countSpintaxVariations } from './SpintaxPreviewCard';
import { getStoredAntiBanConfig } from '../../../utils/antiBanSettings';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';

export interface CampaignCreateWizardProps {
  prefill?: {
    groupId?: number;
    groupName?: string;
    targetCategory?: string;
    category?: string;
    totalLeads?: number;
    whatsappEligible?: number;
  } | null;
  onClearPrefill?: () => void;
  onSuccess: () => void;
  onCancel: () => void;
}

const initialGoalForm = {
  fcOffer: '',
  fcIntro: '',
  fcAdditional: '',
  spProduct: '',
  spBenefit: '',
  spAdditional: '',
  discOffer: '',
  discNeed: '',
  discQuestion: '',
  offOffer: '',
  offSummary: '',
  offBenefit: '',
  offPricing: '',
  meetOffer: '',
  meetPurpose: '',
  meetFormat: '',
  fuPrevious: '',
  fuUpdate: '',
  fuAdditional: '',
};

type WizardStep = 1 | 2 | 3 | 4;

export const CampaignCreateWizard: React.FC<CampaignCreateWizardProps> = ({
  prefill,
  onClearPrefill,
  onSuccess,
  onCancel,
}) => {
  const toast = useToast();
  const { t, language } = useI18n();
  const storedConfig = getStoredAntiBanConfig();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Wizard Stepper State
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);

  // Form State
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [name, setName] = useState(prefill && prefill.groupName ? `${prefill.groupName} - Tanıtım` : '');
  const [targetCategory, setTargetCategory] = useState(prefill ? (prefill.targetCategory || prefill.category || '') : '');
  const [communicationGoal, setCommunicationGoal] = useState<CommunicationGoal | null>(null);
  const [description, setDescription] = useState('');
  const [isTemplateManuallyEdited, setIsTemplateManuallyEdited] = useState(false);
  const [goalForm, setGoalForm] = useState(initialGoalForm);
  const [template, setTemplate] = useState('');
  const [generating, setGenerating] = useState(false);
  const [variationCount, setVariationCount] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Campaign Media Attachment State (Phase 2)
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState<'IMAGE' | 'DOCUMENT' | ''>('');
  const [mediaFilename, setMediaFilename] = useState('');
  const [mediaSizeBytes, setMediaSizeBytes] = useState<number | null>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);

  const handleMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingMedia(true);
    try {
      const res = await ApiClient.uploadCampaignMedia(file);
      setMediaUrl(res.media_url);
      setMediaType(res.media_type === 'IMAGE' ? 'IMAGE' : 'DOCUMENT');
      setMediaFilename(res.filename);
      setMediaSizeBytes(res.size_bytes);
      toast.success(t('campaigns.mediaUploadedSuccess'));
    } catch (err: any) {
      toast.error(err.message || t('campaigns.mediaUploadError'));
    } finally {
      setUploadingMedia(false);
      if (mediaFileInputRef.current) mediaFileInputRef.current.value = '';
    }
  };

  const handleRemoveMedia = () => {
    setMediaUrl('');
    setMediaType('');
    setMediaFilename('');
    setMediaSizeBytes(null);
  };

  const COMMUNICATION_GOALS: Array<{
    id: CommunicationGoal;
    title: string;
    description: string;
    badge: string;
    icon: React.ElementType;
  }> = [
    {
      id: 'FIRST_CONTACT',
      title: t('campaigns.goalFirstContactTitle') || 'İlk Tanışma',
      description: t('campaigns.goalFirstContactDesc') || 'Yeni bir işletmeyle ilk kez iletişim kurmak.',
      badge: '👋 Tanışma',
      icon: Handshake,
    },
    {
      id: 'SERVICE_PROMOTION',
      title: t('campaigns.goalPromoTitle') || 'Ürün / Hizmet Tanıtımı',
      description: t('campaigns.goalPromoDesc') || 'Sunulan ürün veya hizmeti potansiyel müşteriye tanıtmak.',
      badge: '🚀 Tanıtım',
      icon: Sparkles,
    },
    {
      id: 'DISCOVERY',
      title: t('campaigns.goalDiscoveryTitle') || 'İhtiyaç Keşfi',
      description: t('campaigns.goalDiscoveryDesc') || 'Karşı tarafın mevcut ihtiyacını veya kullandığı çözümü anlamak.',
      badge: '🔎 Keşif',
      icon: Search,
    },
    {
      id: 'OFFER',
      title: t('campaigns.goalOfferTitle') || 'Teklif Sunma',
      description: t('campaigns.goalOfferDesc') || 'Belirli bir ürün, hizmet veya ticari teklif sunmak.',
      badge: '💰 Teklif',
      icon: Tag,
    },
    {
      id: 'MEETING',
      title: t('campaigns.goalMeetingTitle') || 'Görüşme Talebi',
      description: t('campaigns.goalMeetingDesc') || 'Telefon, online görüşme, demo veya toplantı talep etmek.',
      badge: '📅 Randevu',
      icon: Calendar,
    },
    {
      id: 'FOLLOW_UP',
      title: t('campaigns.goalFollowUpTitle') || 'Takip Mesajı',
      description: t('campaigns.goalFollowUpDesc') || 'Daha önce yapılan iletişimin devamını sağlamak.',
      badge: '🔄 Takip',
      icon: RefreshCw,
    },
  ];

  const getComputedTemplate = (
    goal: CommunicationGoal | null,
    form: typeof initialGoalForm,
    category: string,
    lang: string
  ): string => {
    const isTr = lang === 'tr';

    if (!goal) {
      return isTr
        ? "{Merhaba|İyi günler|Selamlar} {name},\n\n{city} {district} bölgesindeki işletmenizi gördük. Sizinle iletişime geçmek istedik.\n\nSaygılarımızla."
        : "{Hello|Hi|Greetings} {name},\n\nWe noticed your business in {city} {district}. We would love to get in touch.\n\nBest regards.";
    }

    switch (goal) {
      case 'FIRST_CONTACT': {
        if (form.fcOffer || form.fcIntro) {
          if (isTr) {
            const intro = form.fcIntro ? form.fcIntro : "firmamız ve sunduğumuz kurumsal çözümler";
            const offer = form.fcOffer ? ` Özellikle ${form.fcOffer} alanında faaliyet gösteriyoruz.` : "";
            const extra = form.fcAdditional ? ` ${form.fcAdditional}` : "";
            return `{Merhaba|İyi günler|Selamlar} {name},\n\nFirmanızla tanışmak ve ${intro} hakkında kısaca bilgi paylaşmak istedik.${offer}${extra}\n\nUygunsanız kısa bir özet aktarabiliriz.\n\nSaygılarımızla.`;
          } else {
            const intro = form.fcIntro ? form.fcIntro : "our company and business solutions";
            const offer = form.fcOffer ? ` We specialize in ${form.fcOffer}.` : "";
            const extra = form.fcAdditional ? ` ${form.fcAdditional}` : "";
            return `{Hello|Hi|Greetings} {name},\n\nWe would like to introduce ourselves and briefly share details regarding ${intro}.${offer}${extra}\n\nIf you are available, we can provide a quick overview.\n\nBest regards.`;
          }
        }
        return isTr
          ? "{Merhaba|İyi günler|Selamlar} {name},\n\nFirmanızla tanışmak ve sunduğumuz kurumsal çözümler hakkında kısaca bilgi paylaşmak istedik. Uygunsanız size kısaca bahsedebiliriz.\n\nSaygılarımızla."
          : "{Hello|Hi|Greetings} {name},\n\nWe would like to introduce ourselves and briefly share details about our business solutions. If you are available, we can provide a quick overview.\n\nBest regards.";
      }

      case 'SERVICE_PROMOTION': {
        if (form.spProduct || form.spBenefit) {
          if (isTr) {
            const product = form.spProduct ? form.spProduct : "{category} çözümleri";
            const benefit = form.spBenefit ? ` ${form.spBenefit} avantajları sağlıyoruz.` : "";
            const extra = form.spAdditional ? ` ${form.spAdditional}` : "";
            return `{Merhaba|İyi günler|Selamlar} {name},\n\n{category} faaliyetlerinizde ${product} konusunda${benefit}${extra}\n\nİncelemek isterseniz detaylı ürün ve hizmet bilgilerimizi iletebiliriz.\n\nİyi çalışmalar.`;
          } else {
            const product = form.spProduct ? form.spProduct : "{category} solutions";
            const benefit = form.spBenefit ? ` with key benefits including ${form.spBenefit}.` : ".";
            const extra = form.spAdditional ? ` ${form.spAdditional}` : "";
            return `{Hello|Hi|Greetings} {name},\n\nWe offer specialized ${product} for your {category} operations${benefit}${extra}\n\nPlease let us know if you would like us to share a brief overview.\n\nBest regards.`;
          }
        }
        return isTr
          ? "{Merhaba|İyi günler|Selamlar} {name},\n\n{category} alanındaki faaliyetlerinizde iş süreçlerinizi kolaylaştıran çözümlerimiz ve sunduğumuz avantajlar hakkında kısa bir tanıtım paylaşmak isteriz. İncelemek isterseniz detay iletebiliriz.\n\nİyi çalışmalar."
          : "{Hello|Hi|Greetings} {name},\n\nWe would like to introduce our specialized solutions designed to streamline operations in the {category} sector. Please let us know if you would like us to send a brief overview.\n\nBest regards.";
      }

      case 'DISCOVERY': {
        if (form.discOffer || form.discNeed) {
          if (isTr) {
            const offer = form.discOffer ? `${form.discOffer} çözümlerimiz kapsamında ` : "";
            const need = form.discNeed ? `${form.discNeed} konusunda bir ihtiyacınız veya ` : "";
            const extra = form.discQuestion ? ` Özellikle sormak istedik: ${form.discQuestion}` : "";
            return `{Merhaba|İyi günler|Selamlar} {name},\n\n{category} sektöründeki operasyonlarınızda ${offer}${need}mevcut bir çalışma modeliniz bulunuyor mu?${extra}\n\nUygun olursanız kısa bilgi paylaşabiliriz.\n\nİyi çalışmalar.`;
          } else {
            const offer = form.discOffer ? `Regarding ${form.discOffer}, ` : "";
            const need = form.discNeed ? `do you currently experience a need for ${form.discNeed} or ` : "do you ";
            const extra = form.discQuestion ? ` Specifically: ${form.discQuestion}` : "";
            return `{Hello|Hi|Greetings} {name},\n\n${offer}In your {category} operations, ${need}an existing workflow provider?${extra}\n\nWe would be glad to share quick information if you are available.\n\nBest regards.`;
          }
        }
        return isTr
          ? "{Merhaba|İyi günler|Selamlar} {name},\n\n{category} sektöründeki operasyonlarınızda bu alanda dış çözüm ortağı ihtiyacınız veya kullandığınız mevcut bir sistem bulunuyor mu? Uygun olursanız kısa bilgi paylaşabiliriz.\n\nİyi çalışmalar."
          : "{Hello|Hi|Greetings} {name},\n\nIn your {category} operations, do you currently have a need for external solutions or an existing workflow provider? We would be glad to share quick information if you are available.\n\nBest regards.";
      }

      case 'OFFER': {
        if (form.offOffer || form.offSummary) {
          if (isTr) {
            const offer = form.offOffer ? form.offOffer : "hizmetlerimiz";
            const summary = form.offSummary ? ` (${form.offSummary})` : "";
            const benefit = form.offBenefit ? ` ${form.offBenefit} imkanı sağlıyoruz.` : "";
            const pricing = form.offPricing ? ` Fiyat ve avantaj: ${form.offPricing}.` : "";
            return `{Merhaba|İyi günler|Selamlar} {name},\n\n{category} işletmelerine özel ${offer} paketimizde hazırladığımız avantajlı teklifimizi${summary} değerlendirmeniz için iletmek isteriz.${benefit}${pricing}\n\nUygun bir zamanınızda detayları aktarabilir miyiz?\n\nSaygılarımızla.`;
          } else {
            const offer = form.offOffer ? form.offOffer : "services";
            const summary = form.offSummary ? ` (${form.offSummary})` : "";
            const benefit = form.offBenefit ? ` Key advantage: ${form.offBenefit}.` : "";
            const pricing = form.offPricing ? ` Pricing details: ${form.offPricing}.` : "";
            return `{Hello|Hi|Greetings} {name},\n\nWe would like to present our tailored commercial offer for ${offer}${summary} designed specifically for {category} businesses.${benefit}${pricing}\n\nCan we share a quick overview when convenient?\n\nBest regards.`;
          }
        }
        return isTr
          ? "{Merhaba|İyi günler|Selamlar} {name},\n\n{category} işletmelerine özel hazırladığımız avantajlı fiyat ve hizmet teklifimizi değerlendirmeniz için iletmek isteriz. Uygun bir zamanınızda kısa bilgi paylaşabilir miyiz?\n\nSaygılarımızla."
          : "{Hello|Hi|Greetings} {name},\n\nWe would like to present our tailored commercial offer and cost advantages designed specifically for {category} businesses. Can we share a quick overview when convenient?\n\nBest regards.";
      }

      case 'MEETING': {
        if (form.meetOffer || form.meetPurpose) {
          if (isTr) {
            const offer = form.meetOffer ? `${form.meetOffer} çözümlerimizi ` : "çözümlerimizi ";
            const purpose = form.meetPurpose ? ` (${form.meetPurpose})` : "";
            const format = form.meetFormat ? ` (${form.meetFormat})` : "";
            return `{Merhaba|İyi günler|Selamlar} {name},\n\n{category} faaliyetlerinizde ${offer}ve firmanıza sağlayacağı avantajları değerlendirmek${purpose} adına bu hafta 5 dakikalık kısa bir görüşme${format} organize edebilir miyiz?\n\nİyi çalışmalar.`;
          } else {
            const offer = form.meetOffer ? `our ${form.meetOffer} solutions ` : "our solutions ";
            const purpose = form.meetPurpose ? ` (${form.meetPurpose})` : "";
            const format = form.meetFormat ? ` via ${form.meetFormat}` : "";
            return `{Hello|Hi|Greetings} {name},\n\nCould we schedule a brief 5-minute introductory call${format} this week to explore how ${offer}can benefit your {category} operations${purpose}?\n\nBest regards.`;
          }
        }
        return isTr
          ? "{Merhaba|İyi günler|Selamlar} {name},\n\n{category} alanındaki çözümlerimizi ve firmanıza sağlayacağı avantajları değerlendirmek adına bu hafta 5 dakikalık kısa bir görüşme organize edebilir miyiz?\n\nİyi çalışmalar."
          : "{Hello|Hi|Greetings} {name},\n\nCould we schedule a brief 5-minute introductory call this week to explore how our solutions can benefit your {category} operations?\n\nBest regards.";
      }

      case 'FOLLOW_UP': {
        if (form.fuPrevious || form.fuUpdate) {
          if (isTr) {
            const prev = form.fuPrevious ? `Daha önce görüştüğümüz ${form.fuPrevious} konusuyla ilgili ` : "Önceki bilgilendirmemizle ilgili ";
            const update = form.fuUpdate ? `${form.fuUpdate}. ` : "";
            const extra = form.fuAdditional ? ` ${form.fuAdditional}` : "";
            return `{Merhaba|İyi günler|Selamlar} {name},\n\n${prev}kısa bir durum kontrolü yapmak istedim. ${update}Değerlendirme fırsatınız oldu mu?${extra}\n\nİyi çalışmalar.`;
          } else {
            const prev = form.fuPrevious ? `regarding ${form.fuPrevious} ` : "on our previous conversation ";
            const update = form.fuUpdate ? `${form.fuUpdate}. ` : "";
            const extra = form.fuAdditional ? ` ${form.fuAdditional}` : "";
            return `{Hello|Hi|Greetings} {name},\n\nI just wanted to follow up ${prev}to see if you had a chance to review. ${update}${extra}\n\nBest regards.`;
          }
        }
        return isTr
          ? "{Merhaba|İyi günler|Selamlar} {name},\n\nÖnceki bilgilendirmemizle ilgili kısa bir durum kontrolü yapmak istedim. Değerlendirme fırsatınız oldu mu?\n\nİyi çalışmalar."
          : "{Hello|Hi|Greetings} {name},\n\nI just wanted to follow up on our previous conversation to see if you had a chance to review our information.\n\nBest regards.";
      }
    }
  };

  useEffect(() => {
    if (prefill) {
      if (prefill.groupId) {
        setSelectedGroupId(prefill.groupId);
        setName(`${prefill.groupName || ''} - Tanıtım`.trim());
        const cat = prefill.targetCategory || prefill.category || '';
        if (cat) {
          setTargetCategory(cat);
          setGoalForm((prev) => ({
            ...prev,
            fcOffer: prev.fcOffer || cat,
            spProduct: prev.spProduct || cat,
            discOffer: prev.discOffer || cat,
            offOffer: prev.offOffer || cat,
            meetOffer: prev.meetOffer || cat,
          }));
        } else {
          ApiClient.getCampaignGroup(prefill.groupId)
            .then((detail) => {
              if (detail) {
                const derivedCat = detail.target_category || detail.leads.find((l) => l.category)?.category || '';
                if (derivedCat) {
                  setTargetCategory(derivedCat);
                  setGoalForm((prev) => ({
                    ...prev,
                    fcOffer: prev.fcOffer || derivedCat,
                    spProduct: prev.spProduct || derivedCat,
                    discOffer: prev.discOffer || derivedCat,
                    offOffer: prev.offOffer || derivedCat,
                    meetOffer: prev.meetOffer || derivedCat,
                  }));
                }
              }
            })
            .catch(console.error);
        }
      } else if (prefill.targetCategory || prefill.category) {
        const cat = prefill.targetCategory || prefill.category || '';
        setTargetCategory(cat);
        setGoalForm((prev) => ({
          ...prev,
          fcOffer: prev.fcOffer || cat,
          spProduct: prev.spProduct || cat,
          discOffer: prev.discOffer || cat,
          offOffer: prev.offOffer || cat,
          meetOffer: prev.meetOffer || cat,
        }));
      }
    }
  }, [prefill]);

  const getPayload = useCallback((seed?: number) => {
    let offer_title = '';
    let key_benefit = '';
    let extra_information = '';
    let lead_need = '';
    let specific_question = '';
    let pricing_info = '';
    let meeting_purpose = '';
    let preferred_channel = '';
    let previous_topic = '';

    if (communicationGoal === 'FIRST_CONTACT') {
      offer_title = goalForm.fcOffer;
      key_benefit = goalForm.fcIntro;
      extra_information = goalForm.fcAdditional;
    } else if (communicationGoal === 'SERVICE_PROMOTION') {
      offer_title = goalForm.spProduct;
      key_benefit = goalForm.spBenefit;
      extra_information = goalForm.spAdditional;
    } else if (communicationGoal === 'DISCOVERY') {
      offer_title = goalForm.discOffer;
      lead_need = goalForm.discNeed;
      specific_question = goalForm.discQuestion;
    } else if (communicationGoal === 'OFFER') {
      offer_title = goalForm.offOffer;
      key_benefit = goalForm.offSummary;
      extra_information = goalForm.offBenefit;
      pricing_info = goalForm.offPricing;
    } else if (communicationGoal === 'MEETING') {
      offer_title = goalForm.meetOffer;
      meeting_purpose = goalForm.meetPurpose;
      preferred_channel = goalForm.meetFormat;
    } else if (communicationGoal === 'FOLLOW_UP') {
      previous_topic = goalForm.fuPrevious;
      key_benefit = goalForm.fuUpdate;
      extra_information = goalForm.fuAdditional;
    }

    return {
      communication_goal: communicationGoal!,
      target_category: targetCategory,
      offer_title,
      key_benefit,
      extra_information,
      lead_need,
      specific_question,
      pricing_info,
      meeting_purpose,
      preferred_channel,
      previous_topic,
      language,
      variation_seed: seed !== undefined ? seed : variationCount,
    };
  }, [communicationGoal, goalForm, variationCount, language, targetCategory]);

  // Automatic Debounced AI Message Generation
  useEffect(() => {
    if (!communicationGoal) {
      if (!isTemplateManuallyEdited) {
        setTemplate('');
      }
      return;
    }

    if (isTemplateManuallyEdited) {
      return;
    }

    const isFormValidForGoal = (): boolean => {
      switch (communicationGoal) {
        case 'FIRST_CONTACT':
          return true;
        case 'SERVICE_PROMOTION':
          return !!goalForm.spProduct.trim();
        case 'DISCOVERY':
          return !!goalForm.discOffer.trim() && !!goalForm.discNeed.trim();
        case 'OFFER':
          return !!goalForm.offOffer.trim() && !!goalForm.offSummary.trim();
        case 'MEETING':
          return !!goalForm.meetOffer.trim() && !!goalForm.meetPurpose.trim();
        case 'FOLLOW_UP':
          return !!goalForm.fuPrevious.trim();
        default:
          return true;
      }
    };

    if (!isFormValidForGoal()) {
      const baseline = getComputedTemplate(communicationGoal, goalForm, targetCategory, language);
      setTemplate(baseline);
      return;
    }

    const timer = setTimeout(async () => {
      setGenerating(true);
      try {
        const payload = getPayload(variationCount);
        const res = await ApiClient.generateCampaignMessage(payload);
        if (!isTemplateManuallyEdited) {
          setTemplate(res.generated_message);
        }
      } catch (err: any) {
        if (!isTemplateManuallyEdited) {
          const fallback = getComputedTemplate(communicationGoal, goalForm, targetCategory, language);
          setTemplate(fallback);
        }
      } finally {
        setGenerating(false);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [
    communicationGoal,
    goalForm,
    targetCategory,
    language,
    isTemplateManuallyEdited,
    getPayload,
    variationCount,
  ]);

  const handleSelectGoal = (goalId: CommunicationGoal) => {
    if (communicationGoal === goalId) {
      setCommunicationGoal(null);
      setGoalForm(initialGoalForm);
      setIsTemplateManuallyEdited(false);
      setTemplate('');
    } else {
      setCommunicationGoal(goalId);
      setGoalForm(initialGoalForm);
      setIsTemplateManuallyEdited(false);
      setVariationCount(0);
      const computed = getComputedTemplate(goalId, initialGoalForm, targetCategory, language);
      setTemplate(computed);
    }
  };

  const handleGoalFormFieldChange = (field: keyof typeof initialGoalForm, val: string) => {
    setGoalForm((prev) => ({ ...prev, [field]: val }));
  };

  const handleRegenerateTemplate = async () => {
    if (!communicationGoal) return;
    setGenerating(true);
    try {
      const nextSeed = variationCount + 1;
      const payload = getPayload(nextSeed);
      const res = await ApiClient.generateCampaignMessage(payload);
      setTemplate(res.generated_message);
      setIsTemplateManuallyEdited(false);
      setVariationCount(nextSeed);
      toast.info(t('campaigns.templateRefreshed') || 'Mesaj şablonu yenilendi.', t('common.info'));
    } catch (err: any) {
      const fallback = getComputedTemplate(communicationGoal, goalForm, targetCategory, language);
      setTemplate(fallback);
      setIsTemplateManuallyEdited(false);
      toast.info(t('campaigns.templateRefreshed') || 'Mesaj şablonu yenilendi.', t('common.info'));
    } finally {
      setGenerating(false);
    }
  };

  const insertTag = (tag: string) => {
    setIsTemplateManuallyEdited(true);
    const token = `{${tag}}`;
    if (textareaRef.current) {
      const textarea = textareaRef.current;
      const start = textarea.selectionStart || 0;
      const end = textarea.selectionEnd || 0;
      const currentVal = textarea.value;
      const updated = currentVal.substring(0, start) + token + currentVal.substring(end);
      setTemplate(updated);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + token.length, start + token.length);
      }, 10);
    } else {
      setTemplate((prev) => (prev ? prev + ` ${token}` : token));
    }
  };

  // Step Validation & Navigation
  const handleNextStep = () => {
    if (currentStep === 1) {
      if (!name.trim()) {
        toast.warning(t('campaigns.nameRequiredWarning') || 'Lütfen kampanya adını girin.', t('common.warning'));
        return;
      }
      setCurrentStep(2);
    } else if (currentStep === 2) {
      setCurrentStep(3);
    } else if (currentStep === 3) {
      if (!template.trim()) {
        toast.warning(t('campaigns.templateRequiredWarning') || 'Lütfen mesaj şablonu oluşturun veya girin.', t('common.warning'));
        return;
      }
      setCurrentStep(4);
    }
  };

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => (prev - 1) as WizardStep);
    }
  };

  const handleStepClick = (step: WizardStep) => {
    if (step === currentStep) return;
    if (step > 1 && !name.trim()) {
      toast.warning(t('campaigns.nameRequiredWarning') || 'Lütfen kampanya adını girin.', t('common.warning'));
      return;
    }
    if (step === 4 && !template.trim()) {
      toast.warning(t('campaigns.templateRequiredWarning') || 'Lütfen mesaj şablonu oluşturun veya girin.', t('common.warning'));
      return;
    }
    setCurrentStep(step);
  };

  const handleCreateCampaign = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!name.trim()) {
      toast.warning(t('campaigns.nameRequiredWarning') || 'Lütfen kampanya adını girin.', t('common.warning'));
      setCurrentStep(1);
      return;
    }
    if (!template.trim()) {
      toast.warning(t('campaigns.templateRequiredWarning') || 'Lütfen mesaj şablonu oluşturun veya girin.', t('common.warning'));
      setCurrentStep(3);
      return;
    }

    setIsSubmitting(true);
    try {
      await ApiClient.createCampaign({
        name,
        description,
        message_template: template,
        group_id: selectedGroupId || undefined,
        media_url: mediaUrl.trim() || undefined,
        media_type: (mediaType as any) || undefined,
        media_filename: mediaFilename.trim() || undefined,
        min_delay_seconds: storedConfig.min_delay_seconds,
        max_delay_seconds: storedConfig.max_delay_seconds,
        typing_delay_seconds: storedConfig.typing_delay_seconds,
        working_hours_enabled: storedConfig.working_hours_enabled,
        working_hours_start: storedConfig.working_hours_start,
        working_hours_end: storedConfig.working_hours_end,
      });

      toast.success(t('campaigns.campaignCreatedSuccess') || 'Kampanya taslak olarak başarıyla oluşturuldu.', t('common.success'));
      setName('');
      setTargetCategory('');
      setSelectedGroupId(null);
      if (onClearPrefill) onClearPrefill();
      setCommunicationGoal(null);
      setGoalForm(initialGoalForm);
      setTemplate('');
      setIsTemplateManuallyEdited(false);
      setDescription('');
      handleRemoveMedia();
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const stepItems: Array<{
    step: WizardStep;
    title: string;
    subtitle: string;
    icon: React.ElementType;
  }> = [
    {
      step: 1,
      title: t('campaigns.wizardStep1Title') || 'Temel Bilgiler',
      subtitle: t('campaigns.wizardStep1Subtitle') || 'Hedef Kitle & İsim',
      icon: Target,
    },
    {
      step: 2,
      title: t('campaigns.wizardStep2Title') || 'İletişim Amacı',
      subtitle: t('campaigns.wizardStep2Subtitle') || 'Strateji & Detaylar',
      icon: Sparkles,
    },
    {
      step: 3,
      title: t('campaigns.wizardStep3Title') || 'Mesaj & Spintax',
      subtitle: t('campaigns.wizardStep3Subtitle') || 'Şablon & Önizleme',
      icon: MessageSquare,
    },
    {
      step: 4,
      title: t('campaigns.wizardStep4Title') || 'Güvenlik & Özet',
      subtitle: t('campaigns.wizardStep4Subtitle') || 'Anti-Ban & Onay',
      icon: ShieldCheck,
    },
  ];

  return (
    <div className="w-full space-y-6">
      {/* 1. Senior Vuexy Stepper Header Card */}
      <Card className="p-4 sm:p-5 border-slate-200/70 dark:border-white/[0.06] shadow-xs select-none">
        {/* Progress Bar & Responsive Status */}
        <div className="flex items-center justify-between mb-2.5 text-xs">
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-[#7367F0] animate-pulse" />
            <span className="font-extrabold text-slate-800 dark:text-white">
              {t('campaigns.stepperProgress', {
                current: currentStep,
                total: 4,
                title: stepItems[currentStep - 1].title,
              })}
            </span>
          </div>
          <span className="text-[11px] font-mono font-bold text-slate-400 dark:text-slate-500">
            {Math.round((currentStep / 4) * 100)}%
          </span>
        </div>

        <div className="w-full bg-slate-100 dark:bg-white/[0.06] h-1.5 rounded-full overflow-hidden mb-4">
          <div
            className="bg-[#7367F0] h-full transition-all duration-300 rounded-full"
            style={{ width: `${(currentStep / 4) * 100}%` }}
          />
        </div>

        {/* 4 Interactive Step Buttons */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          {stepItems.map(({ step, title, subtitle, icon: StepIcon }) => {
            const isActive = currentStep === step;
            const isCompleted = currentStep > step;

            return (
              <button
                key={step}
                type="button"
                onClick={() => handleStepClick(step)}
                className={`p-2.5 sm:p-3 rounded-xl text-left transition-all cursor-pointer relative flex items-center space-x-3 border ${
                  isActive
                    ? 'border-[#7367F0] bg-[#7367F0]/[0.08] dark:bg-[#7367F0]/20 ring-2 ring-[#7367F0]/30 shadow-xs'
                    : isCompleted
                    ? 'border-[#28C76F]/30 bg-[#28C76F]/[0.05] dark:bg-[#28C76F]/10 hover:border-[#28C76F]/60'
                    : 'border-slate-200/60 dark:border-white/[0.05] bg-slate-50/60 dark:bg-white/[0.02] hover:border-slate-300 dark:hover:border-white/10'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 font-bold text-xs transition-colors ${
                    isActive
                      ? 'bg-[#7367F0] text-white shadow-xs'
                      : isCompleted
                      ? 'bg-[#28C76F] text-white shadow-xs'
                      : 'bg-slate-200/80 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {isCompleted ? <Check className="w-4 h-4 stroke-[3]" /> : <StepIcon className="w-4 h-4" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center space-x-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96]">
                      0{step}
                    </span>
                    {isCompleted && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#28C76F]" />
                    )}
                  </div>
                  <h5
                    className={`text-xs font-extrabold truncate ${
                      isActive
                        ? 'text-[#7367F0] dark:text-[#A59DF8]'
                        : isCompleted
                        ? 'text-slate-800 dark:text-white'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {title}
                  </h5>
                  <p className="text-[10px] text-slate-400 dark:text-[#7E7F96] truncate hidden sm:block">
                    {subtitle}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* 2. Step Views */}
      <form onSubmit={handleCreateCampaign} noValidate className="space-y-6">
        {/* STEP 1: Basic Info & Target Audience */}
        {currentStep === 1 && (
          <Card className="p-4 sm:p-6 space-y-6 animate-fade-in">
            <FormSection
              title={t('campaigns.wizardStep1Title') || 'Temel Bilgiler & Hedef Kitle'}
              subtitle={t('campaigns.builderInfoSubtitle') || 'Hedef kitlenizi ve kampanyanızın genel kapsamını belirleyin.'}
              icon={Target}
            >
              {/* Selected Group Glassmorphic Banner */}
              {selectedGroupId && prefill?.groupName && (
                <div className="p-4 rounded-xl bg-[#7367F0]/10 border border-[#7367F0]/20 flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
                  <div className="flex items-center space-x-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-[#7367F0] text-white flex items-center justify-center font-bold shrink-0 shadow-xs">
                      <Users className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate block">
                        {t('campaignGroups.campaignBuilderGroupNotice')}: {prefill.groupName}
                      </span>
                      <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] truncate">
                        {t('campaignGroups.campaignBuilderGroupSubtitle', {
                          count: prefill.totalLeads ?? 0,
                          waCount: prefill.whatsappEligible ?? 0,
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    <Badge variant="success" className="text-[10px] font-bold">
                      {prefill.whatsappEligible ?? 0} WA
                    </Badge>
                    <Badge variant="primary" className="text-[10px] font-bold">
                      {t('nav.campaignGroups')}
                    </Badge>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label={t('campaigns.campaignName')} required>
                  <TextInput
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('campaigns.namePlaceholder') || 'Kampanya adı yazın (Örn: Kadıköy Diş Klinikleri Tanıtım Kampanyası)...'}
                    required
                  />
                </FormField>

                <FormField label={t('campaigns.targetCategoryLabel') || 'Hedef Kitle / Sektör'}>
                  <SectorAutocomplete
                    value={targetCategory}
                    onChange={(val) => setTargetCategory(val)}
                    placeholder={t('leadFinder.keywordPlaceholder') || 'Sektör seçin veya yazın...'}
                  />
                </FormField>
              </div>

              <FormField label={t('campaigns.descriptionLabel') || 'Açıklama (İsteğe bağlı)'}>
                <TextInput
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('campaigns.descriptionPlaceholder') || 'Açıklama adı yazın (Örn: Yeni işletme tanışma ve ihtiyaç analizi)...'}
                />
              </FormField>

              {/* Informational Hint Card */}
              <div className="p-3.5 sm:p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] flex items-start space-x-3">
                <div className="w-6 h-6 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0 mt-0.5">
                  <Info className="w-3.5 h-3.5" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {t('campaigns.wizardBasicsTip') || 'Kampanyanıza açıklayıcı bir isim ve sektör belirleyin. Hedef sektör, yapay zekanın mesajlarınızı daha doğru kişiselleştirmesini sağlar.'}
                </p>
              </div>
            </FormSection>
          </Card>
        )}

        {/* STEP 2: Communication Goal & Dynamic Inputs */}
        {currentStep === 2 && (
          <Card className="p-4 sm:p-6 space-y-6 animate-fade-in">
            <FormSection
              title={t('campaigns.communicationGoalTitle') || 'İletişim Amacınız Nedir?'}
              subtitle={t('campaigns.communicationGoalSubtitle') || 'Bu kampanyada işletmelerle hangi amaçla temas kurmak istediğinizi seçin.'}
              icon={Sparkles}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {COMMUNICATION_GOALS.map((goal) => {
                  const isSelected = communicationGoal === goal.id;
                  const IconComponent = goal.icon;

                  return (
                    <div
                      key={goal.id}
                      onClick={() => handleSelectGoal(goal.id)}
                      className={`p-4 rounded-xl border text-left transition-all cursor-pointer relative flex flex-col justify-between space-y-2.5 select-none ${
                        isSelected
                          ? 'border-[#7367F0] bg-[#7367F0]/[0.08] dark:bg-[#7367F0]/15 ring-2 ring-[#7367F0]/30 shadow-xs'
                          : 'border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349]/60 hover:border-[#7367F0]/50 hover:bg-slate-50 dark:hover:bg-white/[0.03]'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center space-x-2.5">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                            isSelected ? 'bg-[#7367F0] text-white shadow-xs' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300'
                          }`}>
                            <IconComponent className="w-4 h-4" />
                          </div>
                          <h5 className="font-extrabold text-xs text-slate-800 dark:text-white">
                            {goal.title}
                          </h5>
                        </div>
                        {isSelected && (
                          <CheckCircle2 className="w-4 h-4 text-[#7367F0] shrink-0" />
                        )}
                      </div>

                      <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] leading-relaxed">
                        {goal.description}
                      </p>

                      <div className="pt-1 flex items-center justify-between">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300">
                          {goal.badge}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Goal-Specific Dynamic Form Fields */}
              {communicationGoal && (
                <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] space-y-4 animate-fade-in">
                  <div className="flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-[#7367F0] animate-pulse" />
                    <h5 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">
                      {t('campaigns.goalDetailsTitle') || 'Amaca Özel Detaylar'}
                    </h5>
                  </div>

                  {communicationGoal === 'FIRST_CONTACT' && (
                    <div className="space-y-3.5">
                      <FormField label={t('campaigns.fcOfferLabel')}>
                        <TextInput
                          value={goalForm.fcOffer}
                          onChange={(e) => handleGoalFormFieldChange('fcOffer', e.target.value)}
                          placeholder={t('campaigns.fcOfferPlaceholder')}
                        />
                      </FormField>
                      <FormField label={t('campaigns.fcIntroLabel')}>
                        <TextInput
                          value={goalForm.fcIntro}
                          onChange={(e) => handleGoalFormFieldChange('fcIntro', e.target.value)}
                          placeholder={t('campaigns.fcIntroPlaceholder')}
                        />
                      </FormField>
                      <FormField label={t('campaigns.fcAdditionalLabel')}>
                        <TextInput
                          value={goalForm.fcAdditional}
                          onChange={(e) => handleGoalFormFieldChange('fcAdditional', e.target.value)}
                          placeholder={t('campaigns.fcAdditionalPlaceholder')}
                        />
                      </FormField>
                    </div>
                  )}

                  {communicationGoal === 'SERVICE_PROMOTION' && (
                    <div className="space-y-3.5">
                      <FormField label={t('campaigns.spProductLabel')} required>
                        <TextInput
                          value={goalForm.spProduct}
                          onChange={(e) => handleGoalFormFieldChange('spProduct', e.target.value)}
                          placeholder={t('campaigns.spProductPlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.spBenefitLabel')}>
                        <TextInput
                          value={goalForm.spBenefit}
                          onChange={(e) => handleGoalFormFieldChange('spBenefit', e.target.value)}
                          placeholder={t('campaigns.spBenefitPlaceholder')}
                        />
                      </FormField>
                      <FormField label={t('campaigns.spAdditionalLabel')}>
                        <TextInput
                          value={goalForm.spAdditional}
                          onChange={(e) => handleGoalFormFieldChange('spAdditional', e.target.value)}
                          placeholder={t('campaigns.spAdditionalPlaceholder')}
                        />
                      </FormField>
                    </div>
                  )}

                  {communicationGoal === 'DISCOVERY' && (
                    <div className="space-y-3.5">
                      <FormField label={t('campaigns.discOfferLabel')} required>
                        <TextInput
                          value={goalForm.discOffer}
                          onChange={(e) => handleGoalFormFieldChange('discOffer', e.target.value)}
                          placeholder={t('campaigns.discOfferPlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.discNeedLabel')} required>
                        <TextInput
                          value={goalForm.discNeed}
                          onChange={(e) => handleGoalFormFieldChange('discNeed', e.target.value)}
                          placeholder={t('campaigns.discNeedPlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.discQuestionLabel')}>
                        <TextInput
                          value={goalForm.discQuestion}
                          onChange={(e) => handleGoalFormFieldChange('discQuestion', e.target.value)}
                          placeholder={t('campaigns.discQuestionPlaceholder')}
                        />
                      </FormField>
                    </div>
                  )}

                  {communicationGoal === 'OFFER' && (
                    <div className="space-y-3.5">
                      <FormField label={t('campaigns.offOfferLabel')} required>
                        <TextInput
                          value={goalForm.offOffer}
                          onChange={(e) => handleGoalFormFieldChange('offOffer', e.target.value)}
                          placeholder={t('campaigns.offOfferPlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.offSummaryLabel')} required>
                        <TextInput
                          value={goalForm.offSummary}
                          onChange={(e) => handleGoalFormFieldChange('offSummary', e.target.value)}
                          placeholder={t('campaigns.offSummaryPlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.offBenefitLabel')}>
                        <TextInput
                          value={goalForm.offBenefit}
                          onChange={(e) => handleGoalFormFieldChange('offBenefit', e.target.value)}
                          placeholder={t('campaigns.offBenefitPlaceholder')}
                        />
                      </FormField>
                      <FormField label={t('campaigns.offPricingLabel')}>
                        <TextInput
                          value={goalForm.offPricing}
                          onChange={(e) => handleGoalFormFieldChange('offPricing', e.target.value)}
                          placeholder={t('campaigns.offPricingPlaceholder')}
                        />
                      </FormField>
                    </div>
                  )}

                  {communicationGoal === 'MEETING' && (
                    <div className="space-y-3.5">
                      <FormField label={t('campaigns.meetOfferLabel')} required>
                        <TextInput
                          value={goalForm.meetOffer}
                          onChange={(e) => handleGoalFormFieldChange('meetOffer', e.target.value)}
                          placeholder={t('campaigns.meetOfferPlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.meetPurposeLabel')} required>
                        <TextInput
                          value={goalForm.meetPurpose}
                          onChange={(e) => handleGoalFormFieldChange('meetPurpose', e.target.value)}
                          placeholder={t('campaigns.meetPurposePlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.meetFormatLabel')}>
                        <TextInput
                          value={goalForm.meetFormat}
                          onChange={(e) => handleGoalFormFieldChange('meetFormat', e.target.value)}
                          placeholder={t('campaigns.meetFormatPlaceholder')}
                        />
                      </FormField>
                    </div>
                  )}

                  {communicationGoal === 'FOLLOW_UP' && (
                    <div className="space-y-3.5">
                      <FormField label={t('campaigns.fuPreviousLabel')} required>
                        <TextInput
                          value={goalForm.fuPrevious}
                          onChange={(e) => handleGoalFormFieldChange('fuPrevious', e.target.value)}
                          placeholder={t('campaigns.fuPreviousPlaceholder')}
                          required
                        />
                      </FormField>
                      <FormField label={t('campaigns.fuUpdateLabel')}>
                        <TextInput
                          value={goalForm.fuUpdate}
                          onChange={(e) => handleGoalFormFieldChange('fuUpdate', e.target.value)}
                          placeholder={t('campaigns.fuUpdatePlaceholder')}
                        />
                      </FormField>
                      <FormField label={t('campaigns.fuAdditionalLabel')}>
                        <TextInput
                          value={goalForm.fuAdditional}
                          onChange={(e) => handleGoalFormFieldChange('fuAdditional', e.target.value)}
                          placeholder={t('campaigns.fuAdditionalPlaceholder')}
                        />
                      </FormField>
                    </div>
                  )}
                </div>
              )}

              {/* Informational Hint */}
              <div className="p-3.5 sm:p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] flex items-start space-x-3">
                <div className="w-6 h-6 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles className="w-3.5 h-3.5" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {t('campaigns.wizardGoalTip') || 'Bir iletişim amacı seçtiğinizde yapay zeka mesajınızı arka planda otomatik olarak oluşturur.'}
                </p>
              </div>
            </FormSection>
          </Card>
        )}

        {/* STEP 3: Message & Spintax Composer + Live Preview */}
        {currentStep === 3 && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
            {/* Left Column: Template Editor */}
            <div className="lg:col-span-7 space-y-5">
              <Card className="p-4 sm:p-6 space-y-5">
                <FormSection
                  title={t('campaigns.templateLabel') || 'Mesaj Şablonu'}
                  subtitle={t('campaigns.templateCardSubtitle') || 'Oluşturulan mesajı buradan düzenleyebilirsiniz.'}
                  icon={MessageSquare}
                >
                  <FormField label={t('campaigns.templateLabel') || 'Mesaj Şablonu'} required>
                    <Textarea
                      ref={textareaRef}
                      rows={9}
                      value={template}
                      onChange={(e) => {
                        setIsTemplateManuallyEdited(true);
                        setTemplate(e.target.value);
                      }}
                      placeholder={t('campaigns.templatePlaceholder')}
                      required
                    />
                  </FormField>

                  {/* Personalization Tag Chips & Live Counters */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block">
                          {t('campaigns.personalizationVariables') || 'Kişiselleştirme Değişkenleri'}
                        </label>
                        <div className="flex items-center space-x-2 text-[11px] font-mono text-slate-400 dark:text-slate-500 sm:hidden">
                          <span>{t('campaigns.charCount', { count: template.length })}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {(language === 'tr'
                          ? [
                              { tag: 'isim', label: '+{isim}' },
                              { tag: 'şehir', label: '+{şehir}' },
                              { tag: 'ilçe', label: '+{ilçe}' },
                              { tag: 'kategori', label: '+{kategori}' },
                              { tag: 'puan', label: '+{puan}' },
                            ]
                          : [
                              { tag: 'name', label: '+{name}' },
                              { tag: 'city', label: '+{city}' },
                              { tag: 'district', label: '+{district}' },
                              { tag: 'category', label: '+{category}' },
                              { tag: 'rating', label: '+{rating}' },
                            ]
                        ).map(({ tag, label }) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => insertTag(tag)}
                            className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-[#7367F0]/10 text-[#7367F0] hover:bg-[#7367F0]/20 border border-[#7367F0]/20 transition-all cursor-pointer"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center space-x-3 sm:self-end">
                      <div className="hidden sm:flex items-center space-x-2 text-[11px] font-mono text-slate-400 dark:text-slate-500">
                        <span>{t('campaigns.charCount', { count: template.length })}</span>
                      </div>

                      {/* Template Actions: Regenerate */}
                      {communicationGoal && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="regenerate-template-btn"
                          onClick={handleRegenerateTemplate}
                          disabled={generating}
                          className="space-x-1.5 text-xs font-bold border-[#7367F0]/30 text-[#7367F0] hover:bg-[#7367F0]/10 cursor-pointer"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
                          <span>{t('campaigns.regenerateTemplateBtn') || 'Mesajı Yenile'}</span>
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Spintax Syntax Guidance Hint */}
                  <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#7367F0]" />
                      <span>{t('campaigns.wizardStep3Title')}</span>
                    </p>
                    <p>
                      {t('campaigns.wizardSpintaxHint') ||
                        'Spintax sözdizimi {Seçenek 1|Seçenek 2|Seçenek 3} şeklinde rastgele varyasyonlar üretir. {isim}, {şehir}, {ilçe}, {kategori} gibi etiketler ise işletme verileriyle otomatik doldurulur.'}
                    </p>
                  </div>
                </FormSection>
              </Card>

              {/* Media Attachment Card (Phase 2) */}
              <Card className="p-4 sm:p-6 space-y-4">
                <FormSection
                  title={t('campaigns.mediaAttachmentTitle')}
                  subtitle={t('campaigns.mediaAttachmentSubtitle')}
                  icon={Paperclip}
                >
                  {mediaUrl ? (
                    <div className="flex items-center justify-between p-3.5 rounded-xl bg-[#7367F0]/10 border border-[#7367F0]/30 animate-fade-in">
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="p-2.5 rounded-lg bg-[#7367F0]/20 text-[#7367F0] shrink-0">
                          {mediaType === 'IMAGE' ? <ImageIcon className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate">
                            {mediaFilename || (mediaType === 'IMAGE' ? t('campaigns.imageAttachment') : t('campaigns.docAttachment'))}
                          </p>
                          <div className="flex items-center space-x-2 text-[11px] text-slate-500 dark:text-slate-400">
                            <span className="font-bold uppercase">{mediaType}</span>
                            {mediaSizeBytes && (
                              <span>• {(mediaSizeBytes / (1024 * 1024)).toFixed(2)} MB</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleRemoveMedia}
                        className="text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20 border-rose-200 dark:border-rose-900/40 p-2 h-auto cursor-pointer"
                        title={t('common.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <input
                        ref={mediaFileInputRef}
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx"
                        onChange={handleMediaUpload}
                        className="hidden"
                      />
                      <div
                        onClick={() => mediaFileInputRef.current?.click()}
                        className={`border-2 border-dashed rounded-xl p-5 text-center transition-all cursor-pointer ${
                          uploadingMedia
                            ? 'border-[#7367F0] bg-[#7367F0]/5 opacity-70'
                            : 'border-slate-300 dark:border-white/10 hover:border-[#7367F0] hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                        }`}
                      >
                        {uploadingMedia ? (
                          <div className="flex flex-col items-center justify-center space-y-2 py-2">
                            <Loader2 className="w-6 h-6 animate-spin text-[#7367F0]" />
                            <p className="text-xs font-bold text-[#7367F0]">{t('campaigns.uploadingMedia')}</p>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center space-y-1.5">
                            <div className="p-2.5 rounded-full bg-[#7367F0]/10 text-[#7367F0]">
                              <Upload className="w-5 h-5" />
                            </div>
                            <p className="text-xs sm:text-sm font-bold text-slate-700 dark:text-slate-200">
                              {t('campaigns.mediaDropzoneTitle')}
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {t('campaigns.mediaDropzoneSubtitle')}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="p-3 rounded-lg bg-slate-50/70 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.05] text-[11px] text-slate-500 dark:text-slate-400 leading-normal">
                    <p>💡 {t('campaigns.mediaCaptionNotice')}</p>
                  </div>
                </FormSection>
              </Card>
            </div>

            {/* Right Column: Live WhatsApp Simulation Card */}
            <div className="lg:col-span-5 space-y-5">
              <SpintaxPreviewCard template={template} targetCategory={targetCategory} />
            </div>
          </div>
        )}

        {/* STEP 4: Review, Anti-Ban & Launch Confirmation */}
        {currentStep === 4 && (
          <div className="space-y-6 animate-fade-in">
            {/* Overview Summary Card */}
            <Card className="p-5 sm:p-6 space-y-6">
              <FormSection
                title={t('campaigns.wizardReviewTitle') || 'Kampanya ve Güvenlik Özeti'}
                subtitle={t('campaigns.wizardReviewSubtitle') || 'Kampanyanızı oluşturmadan önce tüm ayarları ve güvenlik önlemlerini inceleyin.'}
                icon={ShieldCheck}
              >
                {/* 5 Summary Metric Tiles */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
                  <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                      {t('campaigns.wizardSummaryName') || 'Kampanya Adı'}
                    </span>
                    <span className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate block">
                      {name || '-'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                      {t('campaigns.wizardSummaryCategory') || 'Hedef Sektör'}
                    </span>
                    <span className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate block">
                      {targetCategory || t('campaigns.wizardAllCategories') || 'Genel'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                      {t('campaigns.wizardSummaryGoal') || 'İletişim Amacı'}
                    </span>
                    <span className="text-xs sm:text-sm font-extrabold text-[#7367F0] truncate block">
                      {COMMUNICATION_GOALS.find((g) => g.id === communicationGoal)?.title || t('campaigns.wizardAllCategories') || 'Standart'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                      {t('campaigns.wizardSummaryAudience') || 'Hedef Kitle Grubu'}
                    </span>
                    <span className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate block">
                      {prefill?.groupName || t('campaigns.wizardNoGroupSelected') || 'Bağımsız'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                      {t('campaigns.mediaAttachmentLabel')}
                    </span>
                    <span className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate block">
                      {mediaUrl ? (mediaFilename || mediaType || 'Ekli Medya') : t('campaigns.noMediaAttachment')}
                    </span>
                  </div>
                </div>

                {/* Anti-Ban & Safety Protection Shield */}
                <div className="p-4 sm:p-5 rounded-xl bg-[#28C76F]/[0.08] dark:bg-[#28C76F]/15 border border-[#28C76F]/30 space-y-3.5">
                  <div className="flex items-center space-x-3">
                    <div className="w-9 h-9 rounded-xl bg-[#28C76F] text-white flex items-center justify-center font-bold shrink-0 shadow-xs">
                      <Lock className="w-4 h-4" />
                    </div>
                    <div>
                      <h5 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white leading-tight">
                        {t('campaigns.wizardAntibanTitle') || 'Anti-Ban & Mesai Saatleri Koruması'}
                      </h5>
                      <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] mt-0.5">
                        {t('campaigns.wizardAntibanDesc') ||
                          'Bu kampanya, WhatsApp numaranızın spam engeline takılmasını önlemek için Tezlify Anti-Ban politikasıyla fail-closed olarak korunacaktır.'}
                      </p>
                    </div>
                  </div>

                  {/* 3 Parameter Chips */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                    <div className="px-3.5 py-2.5 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#28C76F]/20 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center space-x-2">
                      <Clock className="w-3.5 h-3.5 text-[#28C76F] shrink-0" />
                      <span className="truncate">
                        {t('campaigns.wizardAntibanMinMax', {
                          min: storedConfig.min_delay_seconds,
                          max: storedConfig.max_delay_seconds,
                        }) || `Jitter: ${storedConfig.min_delay_seconds}s - ${storedConfig.max_delay_seconds}s`}
                      </span>
                    </div>

                    <div className="px-3.5 py-2.5 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#28C76F]/20 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center space-x-2">
                      <Sparkles className="w-3.5 h-3.5 text-[#28C76F] shrink-0" />
                      <span className="truncate">
                        {t('campaigns.wizardAntibanTyping', {
                          typing: storedConfig.typing_delay_seconds,
                        }) || `Yazıyor: ${storedConfig.typing_delay_seconds}s`}
                      </span>
                    </div>

                    <div className="px-3.5 py-2.5 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#28C76F]/20 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center space-x-2">
                      <ShieldCheck className="w-3.5 h-3.5 text-[#28C76F] shrink-0" />
                      <span className="truncate">
                        {storedConfig.working_hours_enabled
                          ? t('campaigns.wizardAntibanWorkingHoursActive', {
                              start: storedConfig.working_hours_start,
                              end: storedConfig.working_hours_end,
                            }) || `Mesai: ${storedConfig.working_hours_start} - ${storedConfig.working_hours_end}`
                          : t('campaigns.wizardAntibanWorkingHoursDisabled') || '7/24 Aktif'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Final Message Template Preview Card with Quick Copy */}
                <div className="space-y-2 pt-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block">
                      {t('campaigns.templateLabel') || 'Mesaj Şablonu'}
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        if (!template) return;
                        navigator.clipboard.writeText(template);
                        toast.success(t('campaigns.wizardCopiedSuccess') || 'Mesaj metni panoya kopyalandı!');
                      }}
                      className="text-[11px] font-semibold text-[#7367F0] hover:underline flex items-center space-x-1 cursor-pointer"
                    >
                      <Copy className="w-3 h-3" />
                      <span>{t('campaigns.wizardCopyMessage') || 'Kopyala'}</span>
                    </button>
                  </div>
                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] text-xs font-sans text-slate-700 dark:text-slate-200 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                    {template || '-'}
                  </div>
                </div>
              </FormSection>
            </Card>
          </div>
        )}

        {/* 3. Unified Bottom Stepper Navigation Bar */}
        <Card className="p-4 sm:p-5 shadow-xs border-slate-200/70 dark:border-white/[0.06]">
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
            {/* Cancel Button */}
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              className="cursor-pointer font-bold px-5 border-slate-300 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/5"
            >
              {t('common.cancel') || 'Vazgeç'}
            </Button>

            <div className="flex items-center space-x-2.5 self-end sm:self-center">
              {/* Previous Step Button */}
              {currentStep > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePrevStep}
                  className="space-x-1.5 font-bold cursor-pointer border-slate-300 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/5"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>{t('campaigns.wizardPrevStep') || 'Önceki Adım'}</span>
                </Button>
              )}

              {/* Next Step Button (Steps 1, 2, 3) */}
              {currentStep < 4 ? (
                <>
                  {currentStep === 3 && (
                    <Button
                      type="submit"
                      data-testid="submit-campaign-btn"
                      disabled={isSubmitting}
                      className="space-x-2 font-bold bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30 hover:bg-[#685dd8] cursor-pointer px-5"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>{t('campaigns.wizardFinishBtn') || 'Kampanyayı Oluştur'}</span>
                    </Button>
                  )}

                  <Button
                    type="button"
                    onClick={handleNextStep}
                    className="space-x-1.5 font-bold bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30 hover:bg-[#685dd8] cursor-pointer px-5"
                  >
                    <span>{t('campaigns.wizardNextStep') || 'Sonraki Adım'}</span>
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </>
              ) : (
                /* Step 4 Final Create Campaign Button */
                <Button
                  type="submit"
                  data-testid="submit-campaign-btn"
                  disabled={isSubmitting}
                  className="space-x-2 font-bold bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30 hover:bg-[#685dd8] cursor-pointer px-6"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{isSubmitting ? t('common.loading') : (t('campaigns.wizardFinishBtn') || 'Kampanyayı Oluştur')}</span>
                </Button>
              )}
            </div>
          </div>
        </Card>
      </form>
    </div>
  );
};
