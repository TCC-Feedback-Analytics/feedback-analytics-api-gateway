-- A pergunta própria que o cliente viu no campo de comentário, guardada com o feedback.
-- A IA lê o comentário como resposta a ela. Null = convite padrão (todos os feedbacks de antes).
ALTER TABLE "feedback" ADD COLUMN "comment_prompt" text;