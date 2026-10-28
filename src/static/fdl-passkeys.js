const message = document.getElementById('passkey-message');
const show = (text) => { message.textContent = text; };

const explain = (error) => (error.name === 'NotAllowedError'
  ? 'Opération annulée.'
  : "La clé d'accès n'a pas pu être utilisée. Réessayez ou utilisez un autre moyen.");

async function send(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 403 && data.error?.code === 'elevation_required') {
    location.href = '/admin/confirmation?retour=%2Fcompte%2Fsecurite';
    return new Promise(() => {}); // the page is leaving: stop the flow here
  }
  if (!response.ok) throw new Error('server');
  return data;
}

document.getElementById('passkey-add')?.addEventListener('click', async () => {
  try {
    const optionsJSON = await send('/cles/inscription/options');
    const attestation = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON });
    const name = document.getElementById('passkey-name').value.trim() || "Clé d'accès";
    const result = await send('/cles/inscription/verification', { name, response: attestation });
    if (!result.recoveryCodes) return location.reload();
    const list = document.getElementById('passkey-codes');
    list.replaceChildren(...result.recoveryCodes.map((code) => Object.assign(document.createElement('li'), { textContent: code })));
    show('Clé ajoutée. Notez ces codes de récupération : ils ne seront plus affichés. Rechargez la page ensuite.');
  } catch (error) {
    show(explain(error));
  }
});

document.getElementById('passkey-elevate')?.addEventListener('click', async (event) => {
  try {
    const optionsJSON = await send('/cles/confirmation/options');
    const assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    await send('/cles/confirmation/verification', { response: assertion });
    location.href = event.currentTarget.dataset.retour;
  } catch (error) {
    show(explain(error));
  }
});

document.getElementById('passkey-login')?.addEventListener('click', async () => {
  try {
    const optionsJSON = await send('/cles/connexion/options');
    const assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    await send('/cles/connexion/verification', { response: assertion });
    location.href = '/';
  } catch (error) {
    show(explain(error));
  }
});
