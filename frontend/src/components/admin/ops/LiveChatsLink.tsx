import { MessageSquare, ArrowRight } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardHeader, CardTitle, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';

export interface LiveChatsLinkProps {
  /** Navigates to the WhatsApp hub, which is the only chat surface. */
  onOpenChats: () => void;
}

/**
 * Entry point to live WhatsApp chats.
 *
 * WHY THIS IS A LINK, NOT A CHAT LIST
 * -----------------------------------
 * `/api/v1/whatsapp/conversations` is scoped to the requesting user's own
 * conversations and the backend enforces that ownership server-side
 * (see test_whatsapp_tenant_isolation.py). Rendering a conversation list inside
 * the ADMIN panel would mean either:
 *   a) an admin-only endpoint that bypasses that scoping and exposes other
 *      tenants' WhatsApp traffic to anyone with the admin role, or
 *   b) an admin UI that silently shows the ADMIN's own chats and presents them
 *      as "the live chats".
 * Both are worse than a clear hand-off, so this panel sends the operator to the
 * WhatsApp hub, which renders chats with correct scoping and already carries
 * the realtime session, retry and ordering fixes.
 */
export function LiveChatsLink({ onOpenChats }: LiveChatsLinkProps) {
  const { t } = useI18n();
  return (
    <Card className="border-slate-200 dark:border-white/[0.06]">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-vuexy-primary/10 flex items-center justify-center text-vuexy-primary">
            <MessageSquare className="w-4 h-4" />
          </div>
          <CardTitle className="text-base text-slate-800 dark:text-white">
            {t('admin.ops.tabChats')}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('admin.ops.chatsScopedNote')}
        </p>
        <Button onClick={onOpenChats} className="gap-2">
          {t('admin.ops.chatsOpenHub')}
          <ArrowRight className="w-3.5 h-3.5" />
        </Button>
      </CardContent>
    </Card>
  );
}
