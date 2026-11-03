import { html, sendPage } from '../web.js';

// Every "À compléter" is a fact only the association can give: grep for it before opening to the public.
const TODO = (what) => html`<mark>À compléter : ${what}</mark>`;

const PAGES = {
  '/mentions-legales': ['Mentions légales', html`<h1>Mentions légales</h1>
<h2>Éditeur</h2>
<p>Faim de Lion est édité par l'association LION LAB (loi du 1er juillet 1901).</p>
<ul>
<li>Siège : ${TODO('adresse du siège')}</li>
<li>Numéro RNA : ${TODO('numéro RNA')}</li>
<li>Contact : ${TODO('adresse e-mail de contact')}</li>
<li>Directeur ou directrice de la publication : ${TODO('nom')}</li>
</ul>
<h2>Hébergeur</h2>
<p>${TODO("nom, adresse et téléphone de l'hébergeur")}</p>
<h2>Code et contenus</h2>
<p>Le code source est libre et public sur <a href="https://codeberg.org/LION_LAB/FDL">codeberg.org/LION_LAB/FDL</a>. Licence du code : ${TODO('licence du code')}</p>
<p>Les recettes publiées sont sous licence Creative Commons BY-SA 4.0. Chaque recette indique son auteur.</p>`],

  '/confidentialite': ['Politique de confidentialité', html`<h1>Politique de confidentialité</h1>
<p>Responsable du traitement : l'association LION LAB (voir les <a href="/mentions-legales">mentions légales</a>).</p>
<h2>Ce que nous gardons</h2>
<ul>
<li>Votre compte : adresse e-mail, nom affiché, mot de passe (sous forme d'empreinte, jamais en clair), rôle, date d'inscription.</li>
<li>La double authentification, si vous l'activez : le secret du code à 6 chiffres (chiffré), la partie publique de vos clés d'accès, les empreintes de vos codes de récupération.</li>
<li>Ce que vous publiez : recettes, photos, commentaires, notes et signalements. Une photo est gardée sans ses métadonnées (appareil, position GPS).</li>
<li>Un journal de sécurité : les connexions échouées (adresse e-mail saisie et adresse IP) et les connexions de l'équipe de modération et d'administration (adresse IP).</li>
<li>Les instances Manger! que vous reliez : leur adresse et un jeton d'accès.</li>
</ul>
<h2>Pourquoi</h2>
<p>Pour faire fonctionner le site (conditions d'utilisation) et pour le protéger contre les abus (intérêt légitime). Rien d'autre.</p>
<p>Pas de publicité, pas de traceur, pas de mesure d'audience. Vos données ne sont ni vendues ni transmises, sauf à l'hébergeur qui fait tourner le site et sur demande légale d'une autorité.</p>
<h2>Cookies</h2>
<p>Seulement deux cookies, strictement nécessaires, donc sans bandeau de consentement :</p>
<ul>
<li><code>fdl_session</code> : vous garde connecté, 30 jours (12 heures pour l'équipe de modération et d'administration).</li>
<li><code>fdl_suite</code> : vous ramène à la page de liaison Manger! après la connexion, 10 minutes.</li>
</ul>
<h2>Combien de temps</h2>
<ul>
<li>Compte et contenus : tant que le compte existe.</li>
<li>Compte banni : ses données sont gardées le temps imposé à un hébergeur, puis supprimées. Durée : ${TODO('durée légale à confirmer')}</li>
<li>Journal de sécurité : ${TODO('durée de conservation')}</li>
</ul>
<h2>Vos droits</h2>
<p>Vous pouvez demander l'accès à vos données, leur correction, leur suppression ou leur export, ou vous opposer à un traitement, en écrivant au contact des <a href="/mentions-legales">mentions légales</a>. Il n'y a pas encore de bouton pour supprimer son compte : la demande se fait par ce contact.</p>
<p>Si notre réponse ne vous convient pas, vous pouvez saisir la CNIL (<a href="https://www.cnil.fr">cnil.fr</a>).</p>`],

  '/conditions': ["Conditions d'utilisation", html`<h1>Conditions d'utilisation</h1>
<h2>Le service</h2>
<p>Faim de Lion est une base de recettes communautaire, gratuite, sans publicité, éditée par l'association LION LAB. Pendant la bêta, le site est réservé aux personnes invitées.</p>
<h2>Votre compte</h2>
<p>Un compte appartient à une seule personne. Gardez votre mot de passe pour vous. L'équipe de modération et d'administration doit utiliser une clé d'accès.</p>
<h2>Ce que vous publiez</h2>
<ul>
<li>Vous publiez vos recettes sous licence Creative Commons BY-SA 4.0 : chacun peut les reprendre et les modifier en citant l'auteur et en gardant la même licence. Licence des photos et des commentaires : ${TODO('licence')}</li>
<li>Vous devez avoir le droit de publier ce que vous envoyez. Ne recopiez pas un livre ou un site sans autorisation.</li>
<li>Sont interdits : les contenus illégaux, haineux ou dangereux, la publicité, le spam et les contenus sans rapport avec la cuisine.</li>
</ul>
<h2>Modération</h2>
<p>Les premières recettes d'un compte sont relues avant publication. Une recette ou un commentaire peut être refusé ou retiré ; le motif est visible dans « Mes recettes ». Tout le monde peut signaler un contenu. Un compte qui ne respecte pas ces règles peut être banni, et ses contenus sont alors masqués.</p>
<h2>Manger!</h2>
<p>Vous pouvez relier une instance Manger! à votre compte et retirer cette liaison à tout moment dans « Sécurité du compte ». Une recette que vous supprimez reste dans les instances Manger! qui l'ont déjà importée ; un retrait par la modération y est répercuté.</p>
<h2>Responsabilité</h2>
<p>Les recettes viennent de la communauté. Vérifiez les allergènes, les cuissons et les quantités avant de cuisiner. Le site est fourni sans garantie de disponibilité.</p>
<h2>Changements</h2>
<p>Ces conditions peuvent évoluer ; la nouvelle version s'applique dès sa publication sur cette page. Elles relèvent du droit français.</p>`],

  '/faq': ['Questions fréquentes', html`<h1>Questions fréquentes</h1>
<h2>Qu'est-ce que Faim de Lion ?</h2>
<p>Une base de recettes partagée par une communauté, libre et sans publicité, portée par l'association LION LAB.</p>
<h2>C'est payant ?</h2>
<p>Non. Pas d'abonnement, pas de publicité, pas de traceur.</p>
<h2>Comment rejoindre le site ?</h2>
<p>Pendant la bêta, il faut une invitation d'un membre de l'équipe.</p>
<h2>Pourquoi ma recette n'est-elle pas publiée tout de suite ?</h2>
<p>Les premières recettes d'un compte sont relues par la modération. Après trois recettes publiées, les suivantes paraissent en général directement (un lien ou un mot interdit les renvoie quand même en relecture).</p>
<h2>Comment importer des recettes dans Manger! ?</h2>
<p>Depuis votre instance Manger!, lancez la liaison avec Faim de Lion et acceptez-la ici. Vous pouvez la retirer dans « Sécurité du compte ».</p>
<h2>Comment supprimer mon compte ?</h2>
<p>Écrivez au contact des <a href="/mentions-legales">mentions légales</a>.</p>`],
};

export const LEGAL_PATHS = Object.keys(PAGES);

export function pageRoutes() {
  return Object.fromEntries(Object.entries(PAGES).map(([path, [title, body]]) => [
    `GET ${path}`,
    (request, response) => sendPage(response, 200, title, body),
  ]));
}
