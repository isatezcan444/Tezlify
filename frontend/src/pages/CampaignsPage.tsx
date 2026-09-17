import React, { useState, useEffect } from 'react';
import { 
  Send, 
  Sparkles, 
  Play, 
  ListPlus,
  Loader2,
  Handshake,
  Search,
  Tag,
  Calendar,
  RefreshCw,
  CheckCircle2,
  Target,
  Trash2,
  Users
} from 'lucide-react';
import { ApiClient } from '../api/client';
import { Campaign, CommunicationGoal } from '../types';
import { 
  Button, 
  Badge, 
  Card, 
  PageHeader, 
  EmptyState,
  Modal,
  Pagination,
  BulkActionToolbar,
  ToolbarActionButton
} from '../components/ui';
import { 
  CampaignCard, 
  SpintaxPreviewCard
} from '../features/campaigns/components';
import { 
  FormField, 
  TextInput, 
  Textarea, 
  FormSection 
} from '../components/forms';
import { SectorAutocomplete } from '../features/leads/components';
import { getStoredAntiBanConfig } from '../utils/antiBanSettings';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';

interface CampaignsPageProps {
  onRefreshStats: () => void;
  onNavigate?: (tab: string, prefillData?: any) => void;
  prefill?: {
    groupId?: number;
    groupName?: string;
    targetCategory?: string;
    category?: string;
    totalLeads?: number;
    whatsappEligible?: number;
  } | null;
  onClearPrefill?: () => void;
}

export const CampaignsPage: React.FC<CampaignsPageProps> = ({
  onRefreshStats,
  onNavigate,
  prefill,
  onClearPrefill,
}) => {
  const toast = useToast();
  const { t, language } = useI18n();
  const storedConfig = getStoredAntiBanConfig();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'list' | 'builder'>('list');
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);

  // Pagination State
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Campaign Selection & Bulk Actions State
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Campaign Builder Form
  const [name, setName] = useState(prefill && prefill.groupName ? `${prefill.groupName} - Tanıtım` : '');
  const [targetCategory, setTargetCategory] = useState(prefill ? (prefill.targetCategory || prefill.category || '') : '');
  const [communicationGoal, setCommunicationGoal] = useState<CommunicationGoal | null>(null);
  const [description, setDescription] = useState('');
  const [isTemplateManuallyEdited, setIsTemplateManuallyEdited] = useState(false);

  useEffect(() => {
    if (prefill) {
      setActiveTab('builder');
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
          // If category wasn't explicitly passed in prefill, fetch group detail to derive it
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

  // Campaign Deletion Modal State
  const [campaignToDelete, setCampaignToDelete] = useState<Campaign | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Goal-Specific Form Data (Starts strictly empty - ZERO DUMMY DATA)
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

  const [goalForm, setGoalForm] = useState(initialGoalForm);

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

  const [hasGeneratedTemplate, setHasGeneratedTemplate] = useState(false);
  const [template, setTemplate] = useState('');
  const [generating, setGenerating] = useState(false);
  const [variationCount, setVariationCount] = useState(0);

  const getPayload = (seed?: number) => {
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
  };

  // Automatic Debounced AI Message Generation
  useEffect(() => {
    // If no goal selected, clear template if not manually edited
    if (!communicationGoal) {
      if (!isTemplateManuallyEdited) {
        setTemplate('');
        setHasGeneratedTemplate(false);
      }
      return;
    }

    // If user has already manually edited the message, DO NOT overwrite it with automatic typing updates
    if (isTemplateManuallyEdited) {
      return;
    }

    // Check if the required fields for the active goal are present
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
      // While required fields are still empty, show instantaneous computed baseline template
      const baseline = getComputedTemplate(communicationGoal, goalForm, targetCategory, language);
      setTemplate(baseline);
      setHasGeneratedTemplate(true);
      return;
    }

    // Debounce AI API request (600ms) to avoid request storms while user is typing
    const timer = setTimeout(async () => {
      setGenerating(true);
      try {
        const payload = getPayload(variationCount);
        const res = await ApiClient.generateCampaignMessage(payload);
        // Only apply if user hasn't started manually editing in the meantime
        if (!isTemplateManuallyEdited) {
          setTemplate(res.generated_message);
          setHasGeneratedTemplate(true);
        }
      } catch (err: any) {
        if (!isTemplateManuallyEdited) {
          const fallback = getComputedTemplate(communicationGoal, goalForm, targetCategory, language);
          setTemplate(fallback);
          setHasGeneratedTemplate(true);
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
  ]);

  const handleSelectGoal = (goalId: CommunicationGoal) => {
    if (communicationGoal === goalId) {
      // Deselect
      setCommunicationGoal(null);
      setGoalForm(initialGoalForm);
      setIsTemplateManuallyEdited(false);
      setTemplate('');
      setHasGeneratedTemplate(false);
    } else {
      // Switch goal -> Clear old form state and reset manual edit flag so the new goal's template is generated
      setCommunicationGoal(goalId);
      setGoalForm(initialGoalForm);
      setIsTemplateManuallyEdited(false);
      setVariationCount(0);
      const computed = getComputedTemplate(goalId, initialGoalForm, targetCategory, language);
      setTemplate(computed);
      setHasGeneratedTemplate(true);
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

  const fetchCampaigns = async () => {
    setLoading(true);
    try {
      const data = await ApiClient.getCampaigns();
      setCampaigns(data);
    } catch (err) {
      console.error('Error fetching campaigns:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const insertTag = (tag: string) => {
    setIsTemplateManuallyEdited(true);
    setTemplate((prev) => (prev ? prev + ` {${tag}}` : `{${tag}}`));
  };

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.warning(t('campaigns.nameRequiredWarning') || 'Lütfen kampanya adını girin.', t('common.warning'));
      return;
    }
    if (!template.trim()) {
      toast.warning(t('campaigns.templateRequiredWarning') || 'Lütfen mesaj şablonu oluşturun veya girin.', t('common.warning'));
      return;
    }

    try {
      await ApiClient.createCampaign({
        name,
        description,
        message_template: template,
        group_id: selectedGroupId || undefined,
        min_delay_seconds: storedConfig.min_delay_seconds,
        max_delay_seconds: storedConfig.max_delay_seconds,
        typing_delay_seconds: storedConfig.typing_delay_seconds,
        working_hours_enabled: storedConfig.working_hours_enabled,
        working_hours_start: storedConfig.working_hours_start,
        working_hours_end: storedConfig.working_hours_end,
      });

      toast.success(t('campaigns.campaignCreatedSuccess') || 'Kampanya taslak olarak başarıyla oluşturuldu.', t('common.success'));
      setActiveTab('list');
      setName('');
      setTargetCategory('');
      setSelectedGroupId(null);
      if (onClearPrefill) onClearPrefill();
      setCommunicationGoal(null);
      setGoalForm(initialGoalForm);
      setTemplate('');
      setHasGeneratedTemplate(false);
      setIsTemplateManuallyEdited(false);
      setDescription('');
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handleLaunchCampaign = async (campaignId: number) => {
    try {
      await ApiClient.launchCampaign(campaignId, { limit: 50 });
      toast.success(t('campaigns.campaignLaunched'), t('common.success'));
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handlePauseCampaign = async (campaignId: number) => {
    try {
      await ApiClient.pauseCampaign(campaignId);
      toast.info(t('campaigns.pauseCampaign'), t('common.info'));
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handleCancelCampaign = async (campaignId: number) => {
    const confirmed = await toast.confirm({
      title: t('campaigns.pauseCampaign') + '?',
      message: t('campaigns.pauseCampaignConfirmMsg'),
      confirmText: t('campaigns.pauseCampaign'),
      variant: 'warning',
    });
    if (!confirmed) return;

    try {
      await ApiClient.pauseCampaign(campaignId);
      toast.warning(t('campaigns.pauseCampaign'), t('common.warning'));
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handleOpenDeleteModal = (campaignId: number) => {
    const camp = campaigns.find((c) => c.id === campaignId);
    if (camp) {
      setCampaignToDelete(camp);
      setIsDeleteModalOpen(true);
    }
  };

  const handleConfirmDelete = async () => {
    if (!campaignToDelete) return;
    setIsDeleting(true);
    try {
      await ApiClient.deleteCampaign(campaignToDelete.id);
      toast.success(t('campaigns.campaignDeletedSuccess') || 'Kampanya başarıyla silindi.', t('common.success'));
      setCampaigns((prev) => prev.filter((c) => c.id !== campaignToDelete.id));
      setIsDeleteModalOpen(false);
      setCampaignToDelete(null);
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('campaigns.campaignDeleteError') || t('common.error'), t('toast.errorTitle'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleSelect = (campaignId: number) => {
    setSelectedIds((prev) =>
      prev.includes(campaignId) ? prev.filter((id) => id !== campaignId) : [...prev, campaignId]
    );
  };

  const currentPageCampaigns = campaigns.slice((page - 1) * pageSize, page * pageSize);
  const currentPageIds = currentPageCampaigns.map((c) => c.id);
  const isAllPageSelected = currentPageIds.length > 0 && currentPageIds.every((id) => selectedIds.includes(id));

  const handleToggleSelectAllPage = () => {
    if (isAllPageSelected) {
      setSelectedIds((prev) => prev.filter((id) => !currentPageIds.includes(id)));
      setSelectAllMatching(false);
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentPageIds])));
    }
  };

  const handleSelectAllMatching = () => {
    setSelectedIds(campaigns.map((c) => c.id));
    setSelectAllMatching(true);
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
    setSelectAllMatching(false);
  };

  const handleBulkDelete = async () => {
    const count = selectAllMatching ? campaigns.length : selectedIds.length;
    if (count === 0) return;

    const confirmed = await toast.confirm({
      title: `${t('campaigns.deleteCampaign')} (${count})`,
      message: t('campaigns.bulkDeleteConfirm', { count }),
      confirmText: t('common.delete') || 'Sil',
      variant: 'danger',
    });
    if (!confirmed) return;

    setIsBulkDeleting(true);
    try {
      const targetIds = selectAllMatching ? campaigns.map((c) => c.id) : selectedIds;
      const res = await ApiClient.bulkDeleteCampaigns(targetIds);
      toast.success(res.message || `${res.deleted_count} kampanya silindi.`, t('common.success'));
      setSelectedIds([]);
      setSelectAllMatching(false);
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'Toplu silme işlemi başarısız oldu.', t('toast.errorTitle'));
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Header & Mode Tabs */}
      <Card className="p-4 sm:p-6">
        <PageHeader
          title={t('campaigns.title')}
          subtitle={t('titles.campaignsSub')}
          icon={Send}
          actions={
            <div className="flex items-center space-x-2">
              <Button
                variant={activeTab === 'list' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('list')}
                className={`cursor-pointer font-bold ${activeTab === 'list' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                {t('campaigns.title')} ({campaigns.length})
              </Button>
              <Button
                variant={activeTab === 'builder' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('builder')}
                className={`space-x-1.5 font-bold cursor-pointer ${activeTab === 'builder' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                <ListPlus className="w-3.5 h-3.5" />
                <span>{t('campaigns.createCampaign')}</span>
              </Button>
            </div>
          }
        />
      </Card>

      {activeTab === 'list' ? (
        /* Campaigns List View */
        <div className="space-y-4">
          {campaigns.length === 0 ? (
            <Card className="p-8 text-center">
              <EmptyState
                icon={Send}
                title={t('campaigns.emptyTitle')}
                description={t('campaigns.emptyDescription')}
                action={{
                  label: t('campaigns.createCampaign'),
                  onClick: () => setActiveTab('builder'),
                  icon: Sparkles,
                }}
              />
            </Card>
          ) : (
            <>
              {/* Centralized Bulk Action Toolbar (Identical to LeadCRMPage) */}
              <BulkActionToolbar
                selectedCount={selectedIds.length}
                totalCount={campaigns.length}
                selectAllMatching={selectAllMatching}
                onSelectAllMatching={campaigns.length > selectedIds.length ? handleSelectAllMatching : undefined}
                onClearSelection={handleClearSelection}
                actions={
                  <ToolbarActionButton tone="danger" onClick={handleBulkDelete} disabled={isBulkDeleting}>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isBulkDeleting ? t('common.loading') : `Seçilenleri Sil (${selectedIds.length})`}</span>
                  </ToolbarActionButton>
                }
              />

              {/* Selection & Controls Bar (Slim Aesthetic Card Layout) */}
              <Card className="px-4 py-3 sm:px-5 flex items-center justify-between border-slate-100 dark:border-white/[0.05] bg-white dark:bg-[#2F3349] shadow-sm">
                <label className="flex items-center space-x-2.5 cursor-pointer font-bold text-xs text-slate-700 dark:text-slate-200 select-none group">
                  <input
                    type="checkbox"
                    checked={isAllPageSelected}
                    onChange={handleToggleSelectAllPage}
                    className="w-4 h-4 rounded text-[#7367F0] focus:ring-[#7367F0] focus:ring-offset-0 border-slate-300 dark:border-white/20 dark:bg-[#25293C] cursor-pointer transition-all"
                  />
                  <span className="group-hover:text-[#7367F0] transition-colors">
                    Bu Sayfadakileri Seç ({currentPageCampaigns.length})
                  </span>
                </label>

                {selectedIds.length > 0 ? (
                  <Badge variant="primary" className="text-[10px] font-mono px-2 py-0.5">
                    {selectedIds.length} / {campaigns.length} Seçildi
                  </Badge>
                ) : (
                  <span className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium hidden sm:inline">
                    Toplu işlem için kartları seçebilirsiniz
                  </span>
                )}
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {currentPageCampaigns.map((camp) => (
                  <CampaignCard
                    key={camp.id}
                    campaign={camp}
                    isSelected={selectedIds.includes(camp.id)}
                    onToggleSelect={handleToggleSelect}
                    onStart={handleLaunchCampaign}
                    onPause={handlePauseCampaign}
                    onCancel={handleCancelCampaign}
                    onDelete={handleOpenDeleteModal}
                  />
                ))}
              </div>

              {/* Centralized Pagination matching LeadCRMPage */}
              {campaigns.length > 0 && (
                <Card className="overflow-hidden border-slate-100 dark:border-white/[0.05]">
                  <Pagination
                    currentPage={page}
                    totalItems={campaigns.length}
                    pageSize={pageSize}
                    onPageChange={(newPage) => setPage(newPage)}
                    onPageSizeChange={(newSize) => {
                      setPageSize(newSize);
                      setPage(1);
                    }}
                    pageSizeOptions={[10, 20, 50, 100]}
                  />
                </Card>
              )}
            </>
          )}
        </div>
      ) : (
        /* Spintax Studio & Campaign Builder View */

        <form onSubmit={handleCreateCampaign} noValidate className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Column: Form Controls (Info, Goals, Dynamic Inputs, Anti-Ban) */}
            <div className="lg:col-span-7 space-y-6">
              <Card className="p-6 space-y-6">
                {/* 1. Basic Info & Target Audience */}
                <FormSection
                  title={t('campaigns.campaignName')}
                  subtitle={t('campaigns.builderInfoSubtitle')}
                  icon={Target}
                >
                  {/* Selected Group Badge */}
                  {selectedGroupId && prefill?.groupName && (
                    <div className="p-3.5 rounded-xl bg-[#7367F0]/10 border border-[#7367F0]/20 flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 rounded-lg bg-[#7367F0] text-white flex items-center justify-center font-bold shrink-0">
                          <Users className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-extrabold text-slate-800 dark:text-white truncate block">
                            {t('campaignGroups.campaignBuilderGroupNotice')}: {prefill.groupName}
                          </span>
                          <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                            {t('campaignGroups.campaignBuilderGroupSubtitle', {
                              count: prefill.totalLeads ?? 0,
                              waCount: prefill.whatsappEligible ?? 0,
                            })}
                          </p>
                        </div>
                      </div>
                      <Badge variant="primary" className="text-[10px] shrink-0 font-bold">
                        {t('nav.campaignGroups')}
                      </Badge>
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
                        placeholder={t('leadFinder.keywordPlaceholder')}
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
                </FormSection>

                {/* 2. Communication Goal Selection (İletişim Amacınız Nedir?) */}
                <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] space-y-3">
                  <div>
                    <label className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#7367F0]" />
                      <span>{t('campaigns.communicationGoalTitle') || 'İletişim Amacınız Nedir?'}</span>
                    </label>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] mt-0.5">
                      {t('campaigns.communicationGoalSubtitle') || 'Bu kampanyada işletmelerle hangi amaçla temas kurmak istediğinizi seçin.'}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {COMMUNICATION_GOALS.map((goal) => {
                      const isSelected = communicationGoal === goal.id;
                      const IconComponent = goal.icon;

                      return (
                        <div
                          key={goal.id}
                          onClick={() => handleSelectGoal(goal.id)}
                          className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer relative flex flex-col justify-between space-y-2 select-none ${
                            isSelected
                              ? 'border-[#7367F0] bg-[#7367F0]/[0.08] dark:bg-[#7367F0]/15 ring-2 ring-[#7367F0]/30 shadow-xs'
                              : 'border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349]/60 hover:border-[#7367F0]/50 hover:bg-slate-50 dark:hover:bg-white/[0.03]'
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex items-center space-x-2">
                              <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                                isSelected ? 'bg-[#7367F0] text-white' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-300'
                              }`}>
                                <IconComponent className="w-3.5 h-3.5" />
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
                </div>

                {/* 3. Goal-Specific Dynamic Form Fields (Amaca Göre Ek Bilgiler) */}
                {communicationGoal && (
                  <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] space-y-4 animate-fade-in">
                    <FormSection
                      title={t('campaigns.goalDetailsTitle') || 'Amaca Özel Detaylar'}
                      subtitle={t('campaigns.goalDetailsSubtitle') || 'Seçilen iletişim amacına göre mesajınızı şekillendirecek detayları belirleyin.'}
                      icon={Sparkles}
                    >
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
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    </FormSection>
                  </div>
                )}
              </Card>
            </div>

            {/* Right Column: Spintax Live Preview + Message Template Editor & Launch Action */}
            <div className="lg:col-span-5 space-y-6">
              {/* 1. Spintax Live Variation Preview Card */}
              <SpintaxPreviewCard template={template} targetCategory={targetCategory} />

              {/* 2. Message Template Editor Card (Directly Below Live Preview) */}
              <Card className="p-6 space-y-5">
                <FormSection
                  title={t('campaigns.templateLabel') || 'Mesaj Şablonu'}
                  subtitle={t('campaigns.templateCardSubtitle') || 'Oluşturulan mesajı buradan düzenleyebilirsiniz.'}
                  icon={Sparkles}
                >
                  <FormField 
                    label={t('campaigns.templateLabel') || 'Mesaj Şablonu'} 
                    required 
                  >
                    <Textarea
                      rows={8}
                      value={template}
                      onChange={(e) => {
                        setIsTemplateManuallyEdited(true);
                        setTemplate(e.target.value);
                      }}
                      placeholder={t('campaigns.templatePlaceholder')}
                      required
                    />
                  </FormField>

                  {/* Available Dynamic Field Injection Tags & Regenerate Action */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                    <div>
                      <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
                        {t('campaigns.personalizationVariables') || 'Kişiselleştirme Değişkenleri'}
                      </label>
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

                    {/* Template Actions: Regenerate */}
                    {communicationGoal && (
                      <div className="sm:self-end">
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
                      </div>
                    )}
                  </div>
                </FormSection>
              </Card>
            </div>
          </div>

          {/* Full Width Bottom Action Bar: Cancel & Create Campaign (Right-aligned with offset spacing) */}
          <Card className="p-5 shadow-sm">
            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setActiveTab('list')}
                className="cursor-pointer font-bold px-6 border-slate-300 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/5"
              >
                {t('common.cancel')}
              </Button>

              <Button
                type="submit"
                data-testid="submit-campaign-btn"
                className="space-x-2 font-bold bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30 hover:bg-[#685dd8] cursor-pointer px-6"
              >
                <Sparkles className="w-4 h-4" />
                <span>{t('campaigns.createCampaign')}</span>
              </Button>
            </div>
          </Card>
        </form>
      )}

      {/* Delete Campaign Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => !isDeleting && setIsDeleteModalOpen(false)}
        title={t('campaigns.deleteCampaignTitle') || 'Kampanyayı sil?'}
        subtitle={t('campaigns.deleteCampaignConfirmMsg') || 'Bu kampanyayı silmek istediğinizden emin misiniz? Bu işlem geri alınamaz.'}
        icon={Trash2}
        variant="danger"
        maxWidth="sm"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="cancel-delete-campaign-btn"
              disabled={isDeleting}
              onClick={() => setIsDeleteModalOpen(false)}
              className="cursor-pointer font-bold"
            >
              {t('campaigns.deleteCampaignCancelBtn') || t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="confirm-delete-campaign-btn"
              disabled={isDeleting}
              onClick={handleConfirmDelete}
              className="bg-[#EA5455] hover:bg-[#D43B3C] text-white font-bold space-x-1.5 shadow-md shadow-[#EA5455]/30 cursor-pointer"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('common.loading')}</span>
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  <span>{t('campaigns.deleteCampaignBtn') || 'Kampanyayı Sil'}</span>
                </>
              )}
            </Button>
          </>
        }
      >
        {campaignToDelete && (
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs space-y-1.5">
            <div className="font-bold text-slate-800 dark:text-white flex items-center justify-between">
              <span className="truncate">{campaignToDelete.name}</span>
              <span className="font-mono text-[10px] text-slate-400">ID: #{campaignToDelete.id}</span>
            </div>
            {campaignToDelete.description && (
              <p className="text-slate-500 dark:text-slate-400 text-[11px] line-clamp-2">
                {campaignToDelete.description}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

