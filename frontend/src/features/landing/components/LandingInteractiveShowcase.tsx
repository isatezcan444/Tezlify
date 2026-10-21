import React, { useState, useEffect } from 'react';
import { 
  MapPin, 
  Sparkles, 
  ShieldCheck, 
  MessageSquare, 
  ArrowRight, 
  Search, 
  CheckCircle2, 
  Check, 
  Sliders, 
  Clock, 
  Send,
  Star,
  RefreshCw,
  PhoneCall,
  CheckCheck
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

interface LandingInteractiveShowcaseProps {
  onGetStarted: () => void;
}

export const LandingInteractiveShowcase: React.FC<LandingInteractiveShowcaseProps> = ({ onGetStarted }) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<'scraper' | 'ai' | 'antiban' | 'inbox'>('scraper');

  // Tab 1 state: Scraper preset & animated items
  const [selectedPreset, setSelectedPreset] = useState<number>(0);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanCount, setScanCount] = useState<number>(42);

  const presets = [
    {
      title: t('landing.preset1'),
      city: 'İstanbul / Kadıköy',
      category: 'Diş Klinikleri & Poliklinikler',
      results: [
        { name: 'Acıbadem Dental Klinik', phone: '+90 532 412 88**', rating: 4.9, reviews: 142 },
        { name: 'Moda Gülüş Tasarım Merkezi', phone: '+90 544 892 14**', rating: 4.8, reviews: 98 },
        { name: 'Bağdat Cad. Ağız & Diş Sağlığı', phone: '+90 555 780 33**', rating: 4.9, reviews: 210 },
      ]
    },
    {
      title: t('landing.preset2'),
      city: 'İstanbul / Beşiktaş',
      category: 'Mimarlık & İç Mimarlık Ofisleri',
      results: [
        { name: 'Artisan İç Mimarlık Stüdyosu', phone: '+90 533 610 22**', rating: 4.9, reviews: 64 },
        { name: 'Levent Tasarım & Proje Grubu', phone: '+90 530 455 19**', rating: 4.7, reviews: 88 },
        { name: 'Boğaziçi Yapı & Restorasyon', phone: '+90 542 901 77**', rating: 5.0, reviews: 45 },
      ]
    },
    {
      title: t('landing.preset3'),
      city: 'Ankara / Çankaya',
      category: 'Özel Eğitim & Kurs Merkezleri',
      results: [
        { name: 'Çankaya Akademi Hazırlık Kursu', phone: '+90 535 332 11**', rating: 4.8, reviews: 176 },
        { name: 'Gordion Dil & Kariyer Enstitüsü', phone: '+90 546 880 44**', rating: 4.9, reviews: 120 },
        { name: 'Kızılay Özel Etüt Merkezi', phone: '+90 505 123 66**', rating: 4.7, reviews: 94 },
      ]
    }
  ];

  const handleSelectPreset = (idx: number) => {
    setSelectedPreset(idx);
    setIsScanning(true);
    setScanCount(0);
    let current = 0;
    const interval = setInterval(() => {
      current += 6;
      if (current >= 42) {
        setScanCount(42);
        setIsScanning(false);
        clearInterval(interval);
      } else {
        setScanCount(current);
      }
    }, 60);
  };

  // Tab 2 state: AI Tone
  const [selectedTone, setSelectedTone] = useState<'friendly' | 'corporate' | 'discovery'>('friendly');
  const getAiMessage = () => {
    const bizName = presets[selectedPreset].results[0].name;
    if (selectedTone === 'friendly') {
      return `Selamlar ${bizName} ekibi 👋 Kadıköy bölgesindeki başarılı hasta yorumlarınızı inceledik. Yeni nesil dijital randevu otomasyonumuz ile kliniğinize her ay 25+ yeni özel hasta yönlendirebiliyoruz. 2 dakikalık kısa vaka videomuzu WhatsApp üzerinden iletmemi ister misiniz?`;
    } else if (selectedTone === 'corporate') {
      return `Sayın ${bizName} Yetkilisi, Sağlık sektöründe faaliyet gösteren polikliniklerin randevu doluluk oranlarını %40 artıran kurumsal B2B hasta edinme altyapımızın fizibilite raporunu takdirlerinize sunmak isteriz. İlgili departmanınızla paylaşmamız için uygun mudur?`;
    } else {
      return `Merhaba ${bizName}, bölgenizde artan klinik rekabetinde Google Haritalar üzerinden doğrudan WhatsApp'a hasta çekme sürecinizde yaşadığınız en büyük darboğaz nedir? Çözüm mimarimizi kısaca paylaşabiliriz.`;
    }
  };

  // Tab 3 state: Anti-Ban Jitter slider
  const [jitterRange, setJitterRange] = useState<number>(45);

  // Tab 4 state: Live Chat Simulation
  const [chatMessages, setChatMessages] = useState<Array<{ sender: 'bot' | 'lead'; text: string; time: string }>>([
    {
      sender: 'bot',
      text: 'Merhaba Ahmet Bey, kliniğiniz için hazırladığımız özel vaka çalışmasını incelemek ister misiniz?',
      time: '11:02'
    },
    {
      sender: 'lead',
      text: 'Merhaba, detayları ve fiyatlandırmayı PDF olarak iletir misiniz?',
      time: '11:05'
    }
  ]);
  const [inputText, setInputText] = useState<string>('');

  const handleSendReply = (customText?: string) => {
    const textToSend = customText || inputText;
    if (!textToSend.trim()) return;

    setChatMessages((prev) => [
      ...prev,
      {
        sender: 'bot',
        text: textToSend,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]);
    setInputText('');
  };

  return (
    <section id="how-it-works" className="py-20 sm:py-32 select-none relative overflow-hidden">
      {/* Background radial glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] bg-gradient-to-tr from-[#7367F0]/10 via-[#00CFE8]/5 to-transparent blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-12 sm:mb-16">
          <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-bold bg-[#7367F0]/10 text-[#7367F0] dark:bg-[#7367F0]/20 dark:text-[#A59DF8] mb-4 border border-[#7367F0]/20">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('landing.showcaseBadge')}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
            {t('landing.heroTitlePrefix')}{' '}
            <span className="font-serif italic font-normal text-shimmer">
              {t('landing.showcaseTitle')}
            </span>
          </h2>

          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-400">
            {t('landing.showcaseSubtitle')}
          </p>
        </div>

        {/* 4 Interactive Step Tabs */}
        <div className="flex items-center justify-start sm:justify-center gap-2 overflow-x-auto pb-4 mb-8 scrollbar-none w-full max-w-full px-1">
          <button
            type="button"
            onClick={() => setActiveTab('scraper')}
            className={`flex items-center gap-2 px-4 sm:px-5 py-3 rounded-2xl text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 active:scale-95 ${
              activeTab === 'scraper'
                ? 'bg-[#7367F0] text-white shadow-lg shadow-[#7367F0]/30 scale-[1.02]'
                : 'landing-glass-card text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <MapPin className="w-4 h-4 shrink-0" />
            <span>{t('landing.showcaseTab1')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('ai')}
            className={`flex items-center gap-2 px-4 sm:px-5 py-3 rounded-2xl text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 active:scale-95 ${
              activeTab === 'ai'
                ? 'bg-[#7367F0] text-white shadow-lg shadow-[#7367F0]/30 scale-[1.02]'
                : 'landing-glass-card text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Sparkles className="w-4 h-4 shrink-0" />
            <span>{t('landing.showcaseTab2')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('antiban')}
            className={`flex items-center gap-2 px-4 sm:px-5 py-3 rounded-2xl text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 active:scale-95 ${
              activeTab === 'antiban'
                ? 'bg-[#7367F0] text-white shadow-lg shadow-[#7367F0]/30 scale-[1.02]'
                : 'landing-glass-card text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>{t('landing.showcaseTab3')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('inbox')}
            className={`flex items-center gap-2 px-4 sm:px-5 py-3 rounded-2xl text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 active:scale-95 ${
              activeTab === 'inbox'
                ? 'bg-[#7367F0] text-white shadow-lg shadow-[#7367F0]/30 scale-[1.02]'
                : 'landing-glass-card text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <MessageSquare className="w-4 h-4 shrink-0" />
            <span>{t('landing.showcaseTab4')}</span>
          </button>
        </div>

        {/* Interactive Canvas Surface */}
        <div className="landing-glass-card rounded-3xl p-6 sm:p-10 border border-slate-200/80 dark:border-white/[0.1] shadow-2xl transition-all">
          {/* TAB 1: SCRAPER RADAR */}
          {activeTab === 'scraper' && (
            <div className="space-y-6 animate-fade-in">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-white/[0.06]">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">
                    {t('landing.presetLabel')}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {presets.map((p, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => handleSelectPreset(idx)}
                        className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                          selectedPreset === idx
                            ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
                            : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/[0.08]'
                        }`}
                      >
                        {p.title}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="p-3 rounded-2xl bg-[#28C76F]/10 text-[#28C76F] flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#28C76F] animate-ping" />
                    <span className="text-xs font-black">
                      {isScanning ? t('landing.scanningStatus') : `${scanCount} ${t('landing.scanFoundCount')}`}
                    </span>
                  </div>
                </div>
              </div>

              {/* Scraped Leads Table */}
              <div className="space-y-3">
                <div className="text-xs font-bold text-slate-500 flex items-center justify-between">
                  <span>{presets[selectedPreset].city} • {presets[selectedPreset].category}</span>
                  <span className="text-[#7367F0] font-mono">{t('landing.scanScore')}</span>
                </div>

                <div className="divide-y divide-slate-100 dark:divide-white/[0.06] rounded-2xl border border-slate-200/80 dark:border-white/[0.08] bg-white/60 dark:bg-[#25293C]/60 overflow-hidden">
                  {presets[selectedPreset].results.map((res, rIdx) => (
                    <div
                      key={rIdx}
                      className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/80 dark:hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center font-bold text-sm shrink-0">
                          {res.name.charAt(0)}
                        </div>
                        <div>
                          <div className="text-sm font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
                            <span>{res.name}</span>
                            <div className="flex items-center gap-1 text-[11px] text-amber-500 font-bold">
                              <Star className="w-3.5 h-3.5 fill-current" />
                              <span>{res.rating}</span>
                              <span className="text-slate-400 font-normal">({res.reviews})</span>
                            </div>
                          </div>
                          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                            {res.phone}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-[#28C76F]/10 text-[#28C76F] border border-[#28C76F]/20 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{t('landing.phoneValidBadge')}</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: AI COPY & SPINTAX */}
          {activeTab === 'ai' && (
            <div className="space-y-6 animate-fade-in">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-white/[0.06]">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">
                    {t('landing.toneLabel')}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedTone('friendly')}
                      className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        selectedTone === 'friendly'
                          ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
                          : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {t('landing.toneFriendly')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedTone('corporate')}
                      className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        selectedTone === 'corporate'
                          ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
                          : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {t('landing.toneCorporate')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedTone('discovery')}
                      className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        selectedTone === 'discovery'
                          ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
                          : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {t('landing.toneDiscovery')}
                    </button>
                  </div>
                </div>

                <div className="text-xs text-slate-400 max-w-xs text-left sm:text-right">
                  {t('landing.spintaxExplanation')}
                </div>
              </div>

              {/* Dynamic Spintax Breakdown & Preview */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
                <div className="p-5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] space-y-3">
                  <div className="text-xs font-black uppercase tracking-wider text-[#7367F0] flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{t('landing.spintaxBreakdownTitle')}</span>
                  </div>
                  <div className="font-mono text-xs text-slate-700 dark:text-slate-300 leading-relaxed p-3.5 rounded-xl bg-slate-50 dark:bg-[#1E2235] border border-slate-200/60 dark:border-white/[0.04]">
                    <span className="text-purple-500 font-bold">{'{Selamlar|Merhaba|İyi günler}'}</span>{' '}
                    <span className="text-emerald-500 font-bold">{'[İşletme Adı]'}</span> ekibi...{' '}
                    <span className="text-blue-500 font-bold">{'{randevu doluluk|yeni hasta çekim}'}</span> oranınızı %40 artıracak...
                  </div>
                  <p className="text-[11px] text-slate-400">
                    {t('landing.spintaxBreakdownDesc')}
                  </p>
                </div>

                {/* WhatsApp Chat Bubble Mockup */}
                <div className="p-5 rounded-2xl whatsapp-chat-bg border border-slate-200/80 dark:border-white/[0.08] flex flex-col justify-end">
                  <div className="p-4 rounded-2xl bg-white dark:bg-[#202c33] text-slate-900 dark:text-[#e9edef] text-xs leading-relaxed shadow-md space-y-2 max-w-md self-end">
                    <p>{getAiMessage()}</p>
                    <div className="flex items-center justify-end gap-1 text-[10px] text-slate-400">
                      <span>11:15</span>
                      <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: ANTI-BAN CONTROLLER */}
          {activeTab === 'antiban' && (
            <div className="space-y-6 animate-fade-in">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                <div className="space-y-5">
                  <div>
                    <h4 className="text-lg font-black text-slate-900 dark:text-white">
                      {t('landing.jitterLabel')}
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      {t('landing.banRiskDesc')}
                    </p>
                  </div>

                  {/* Interactive Slider */}
                  <div className="p-4 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] space-y-3">
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span className="text-slate-600 dark:text-slate-300">{t('landing.jitterRangeLabel')}</span>
                      <span className="text-[#7367F0] font-mono font-black text-sm">
                        {jitterRange}s - {jitterRange + 35}s
                      </span>
                    </div>

                    <input
                      type="range"
                      min={15}
                      max={75}
                      value={jitterRange}
                      onChange={(e) => setJitterRange(Number(e.target.value))}
                      className="w-full accent-[#7367F0] cursor-pointer"
                    />

                    <div className="flex justify-between text-[11px] text-slate-400">
                      <span>{t('landing.jitterFast')}</span>
                      <span>{t('landing.jitterRecommended')}</span>
                      <span>{t('landing.jitterUltraSafe')}</span>
                    </div>
                  </div>

                  {/* Working Hours Guard Card */}
                  <div className="p-4 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500">
                        <Clock className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-slate-800 dark:text-white">
                          {t('landing.workingHoursLabel')}
                        </div>
                        <div className="text-[11px] text-slate-400">{t('landing.workingHoursSubtext')}</div>
                      </div>
                    </div>
                    <span className="px-3 py-1 rounded-lg text-xs font-extrabold bg-[#28C76F]/10 text-[#28C76F]">
                      {t('landing.workingHoursActive')}
                    </span>
                  </div>
                </div>

                {/* Visual Ban Risk Radar Meter */}
                <div className="p-6 rounded-3xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] flex flex-col items-center text-center">
                  <div className="relative w-36 h-36 flex items-center justify-center mb-4">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle
                        cx="72"
                        cy="72"
                        r="60"
                        stroke="currentColor"
                        strokeWidth="10"
                        className="text-slate-200 dark:text-white/10"
                        fill="transparent"
                      />
                      <circle
                        cx="72"
                        cy="72"
                        r="60"
                        stroke="#28C76F"
                        strokeWidth="10"
                        strokeDasharray={376}
                        strokeDashoffset={10}
                        strokeLinecap="round"
                        className="transition-all duration-1000"
                        fill="transparent"
                      />
                    </svg>
                    <div className="absolute flex flex-col items-center">
                      <span className="text-2xl font-black text-[#28C76F]">0%</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase">{t('landing.banRiskLabel')}</span>
                    </div>
                  </div>

                  <h5 className="font-extrabold text-slate-900 dark:text-white text-base">
                    {t('landing.banRiskTitle')}: <span className="text-[#28C76F]">{t('landing.banRiskZero')}</span>
                  </h5>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs">
                    {t('landing.banRiskExplanation')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: LIVE INBOX SIMULATOR */}
          {activeTab === 'inbox' && (
            <div className="space-y-4 animate-fade-in">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/[0.06]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#28C76F]/20 text-[#28C76F] font-bold flex items-center justify-center text-sm">
                    AB
                  </div>
                  <div>
                    <div className="text-sm font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
                      <span>Ahmet Bey • Acıbadem Dental</span>
                      <span className="w-2 h-2 rounded-full bg-[#28C76F]" />
                    </div>
                    <div className="text-xs text-slate-400 font-mono">+90 532 412 88**</div>
                  </div>
                </div>

                <span className="px-3 py-1 rounded-full text-xs font-bold bg-[#FF9F43]/10 text-[#FF9F43] border border-[#FF9F43]/20">
                  {t('landing.incomingLeadNotice')}
                </span>
              </div>

              {/* Chat Thread */}
              <div className="p-4 rounded-2xl whatsapp-chat-bg border border-slate-200/80 dark:border-white/[0.08] min-h-[200px] max-h-[260px] overflow-y-auto space-y-3">
                {chatMessages.map((msg, mIdx) => (
                  <div
                    key={mIdx}
                    className={`flex flex-col ${msg.sender === 'bot' ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`p-3.5 rounded-2xl text-xs max-w-sm sm:max-w-md shadow-sm ${
                        msg.sender === 'bot'
                          ? 'bg-white dark:bg-[#202c33] text-slate-900 dark:text-[#e9edef] rounded-tr-none'
                          : 'bg-[#d9fdd3] dark:bg-[#005c4b] text-slate-900 dark:text-[#e9edef] rounded-tl-none'
                      }`}
                    >
                      <p>{msg.text}</p>
                      <div className="flex items-center justify-end gap-1 text-[10px] text-slate-400 mt-1">
                        <span>{msg.time}</span>
                        {msg.sender === 'bot' && <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Quick Preset Replies */}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <span className="text-[11px] font-bold text-slate-400">{t('landing.quickRepliesLabel')}</span>
                <button
                  type="button"
                  onClick={() => handleSendReply('Tabii ki Ahmet Bey, kurumsal hasta çekim PDF dosyamızı ve fiyat tablosunu iletiyorum.')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-white/[0.05] hover:bg-slate-200 dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
                >
                  {t('landing.quickReplyPdf')}
                </button>
                <button
                  type="button"
                  onClick={() => handleSendReply('Harika! Yarın saat 14:00 veya 16:00 için kısa bir 15 dakikalık online demo planlayabilir miyiz?')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-white/[0.05] hover:bg-slate-200 dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
                >
                  {t('landing.quickReplyDemo')}
                </button>
              </div>

              {/* Chat Input Bar */}
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSendReply();
                  }}
                  placeholder={t('landing.replyPlaceholder')}
                  className="flex-1 min-w-0 h-11 px-3 sm:px-4 rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#25293C] text-xs text-slate-800 dark:text-white focus:outline-none focus:border-[#7367F0]"
                />
                <button
                  type="button"
                  onClick={() => handleSendReply()}
                  className="h-11 px-3.5 sm:px-5 shrink-0 rounded-xl bg-[#7367F0] hover:bg-[#685DD8] text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-[#7367F0]/30 transition-all cursor-pointer active:scale-95"
                >
                  <span>{t('landing.sendReplyBtn')}</span>
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Bottom Action Bar */}
          <div className="mt-8 pt-6 border-t border-slate-100 dark:border-white/[0.06] flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-slate-500 dark:text-slate-400 text-center sm:text-left">
              {t('landing.setupTimeNote')}
            </div>

            <button
              type="button"
              onClick={onGetStarted}
              className="w-full sm:w-auto h-12 px-6 rounded-2xl bg-[#7367F0] hover:bg-[#685DD8] text-white font-bold text-xs sm:text-sm shadow-lg shadow-[#7367F0]/30 transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95"
            >
              <span>{t('landing.testThisFlow')}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
