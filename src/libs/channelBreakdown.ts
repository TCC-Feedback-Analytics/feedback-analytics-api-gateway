/**
 * Por onde chegaram as avaliações (etapa 06): QR Code, link compartilhado,
 * etiqueta NFC e as sem marca de canal. O "Testar o formulário" (TEST) conta
 * como feedback nas outras métricas, mas não é um canal de coleta.
 */
import type {
  ChannelRatingSummary,
  CollectionChannel,
} from '@feedback/lib-shared/schemas/public/feedbackChannel';
import { ratingStats } from './statistics/index.js';

export interface ChannelRatingRow {
  channel: string | null;
  rating: number | null;
  count: number;
}

/** Ordem fixa na tela; as sem marca vêm por último. */
const CHANNEL_ORDER: Array<CollectionChannel | null> = ['QR', 'LINK', 'NFC', null];

export function summarizeChannels(rows: ChannelRatingRow[]): ChannelRatingSummary[] {
  return CHANNEL_ORDER.flatMap((channel) => {
    const counts: Record<number, number> = {};
    let count = 0;
    for (const row of rows) {
      if ((row.channel ?? null) !== channel) continue;
      count += row.count;
      if (row.rating != null) counts[row.rating] = (counts[row.rating] ?? 0) + row.count;
    }
    if (count === 0) return [];
    const stats = ratingStats(counts);
    return [{
      channel,
      count,
      mean: stats.n > 0 ? stats.mean : null,
      ci: stats.n > 0 ? stats.ci : null,
    }];
  });
}
