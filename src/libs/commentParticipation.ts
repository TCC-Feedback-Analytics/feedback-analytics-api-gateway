/**
 * Participação nos comentários (o comentário é opcional no formulário): quantas
 * avaliações trazem um comentário escrito e se a nota de quem comenta difere da
 * de quem só dá as estrelas. Diz o quanto o tom dos comentários representa o escopo.
 */
import type { CommentParticipation, CommentGroupRating } from '@feedback/lib-shared/interfaces/domain/feedback.domain';
import { confidenceTier, pctInterval, ratingStats } from './statistics/index.js';

export interface CommentRatingRow {
  hasComment: boolean;
  /** Comentário escrito, mas curto demais para dizer algo ("bom", "ok"). */
  isShort?: boolean;
  rating: number | null;
  count: number;
}

function groupRating(rows: CommentRatingRow[], hasComment: boolean): CommentGroupRating | null {
  const counts: Record<number, number> = {};
  for (const row of rows) {
    if (row.hasComment !== hasComment || row.rating == null) continue;
    counts[row.rating] = (counts[row.rating] ?? 0) + row.count;
  }
  const stats = ratingStats(counts);
  return stats.n > 0 ? { n: stats.n, mean: stats.mean, ci: stats.ci } : null;
}

export function summarizeCommentParticipation(rows: CommentRatingRow[]): CommentParticipation {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const withComment = rows.filter((row) => row.hasComment).reduce((sum, row) => sum + row.count, 0);
  return {
    total,
    withComment,
    pct: total > 0 ? Math.round((withComment / total) * 1000) / 10 : 0,
    ci: total > 0 ? pctInterval(withComment, total) : { lower: 0, upper: 0 },
    confidenceTier: confidenceTier(total),
    withCommentRating: groupRating(rows, true),
    withoutCommentRating: groupRating(rows, false),
    shortComments: rows.filter((row) => row.hasComment && row.isShort).reduce((sum, row) => sum + row.count, 0),
  };
}
