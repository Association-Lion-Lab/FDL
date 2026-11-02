import { addComment, deleteComment, editComment, getOwnComment } from '../comments.js';
import { html, readBody, redirect } from '../web.js';
import { clientIp, field, tooMany } from './auth.js';
import { recipePage, show } from './catalogue.js';
import { parseId } from './contributions.js';

const notFound = (response) => show(response, 404, 'Commentaire introuvable', html`<h1>Commentaire introuvable</h1>
<p>Ce commentaire n'existe pas ou n'est plus visible.</p>`);

const back = (response, recipeId) => redirect(response, `/recette?id=${recipeId}#commentaires`);

function editPage(response, { id, text, error = null, status = 200 }) {
  show(response, status, 'Modifier mon commentaire', html`<h1>Modifier mon commentaire</h1>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<form method="post" action="/recette/commentaire/modifier">
<input type="hidden" name="id" value="${id}">
<label>Votre commentaire (1 000 caractères au plus) <textarea name="texte">${text}</textarea></label>
<button type="submit">Enregistrer</button>
</form>`);
}

export function commentRoutes(pool, config, { limiter }) {
  const limited = (request) => {
    const { accountId } = request.session;
    return limiter.hit(`comment:${accountId}`, { scope: 'comment', accountId, ip: clientIp(request) });
  };
  return {
    'POST /recette/commentaire': async (request, response) => {
      if (limited(request)) return tooMany(response);
      const body = await readBody(request);
      const recipeId = parseId(field(body, 'id'));
      const text = field(body, 'texte');
      if (!recipeId) return recipePage(pool, request, response, '');
      try {
        await addComment(pool, { recipeId, authorId: request.session.accountId, body: text, dataDir: config.dataDir });
      } catch (error) {
        if (error.code === 'invalid_comment') return recipePage(pool, request, response, recipeId, { status: 400, error: error.message, text });
        if (error.code === 'not_found') return recipePage(pool, request, response, '');
        throw error;
      }
      back(response, recipeId);
    },

    'GET /recette/commentaire/modifier': async (request, response) => {
      const commentId = parseId(new URL(request.url, 'http://x').searchParams.get('id') ?? '');
      const own = commentId && await getOwnComment(pool, { commentId, authorId: request.session.accountId });
      if (!own) return notFound(response);
      editPage(response, { id: own.id, text: own.body });
    },

    'POST /recette/commentaire/modifier': async (request, response) => {
      if (limited(request)) return tooMany(response);
      const body = await readBody(request);
      const commentId = parseId(field(body, 'id'));
      const text = field(body, 'texte');
      const authorId = request.session.accountId;
      const own = commentId && await getOwnComment(pool, { commentId, authorId });
      if (!own) return notFound(response);
      try {
        await editComment(pool, { commentId, authorId, body: text, dataDir: config.dataDir });
      } catch (error) {
        if (error.code === 'invalid_comment') return editPage(response, { id: commentId, text, error: error.message, status: 400 });
        if (error.code === 'not_found') return notFound(response);
        throw error;
      }
      back(response, own.recipeId);
    },

    'POST /recette/commentaire/supprimer': async (request, response) => {
      const body = await readBody(request);
      const commentId = parseId(field(body, 'id'));
      const authorId = request.session.accountId;
      const recipeId = commentId && await deleteComment(pool, { commentId, authorId });
      if (!recipeId) return notFound(response);
      back(response, recipeId);
    },
  };
}
