const message = document.getElementById('passkey-message');
const show = (text) => { message.textContent = text; };

async function send(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message ?? 'Une erreur est survenue.');
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
    show(error.message);
  }
});

document.getElementById('passkey-login')?.addEventListener('click', async () => {
  try {
    const optionsJSON = await send('/cles/connexion/options');
    const assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    await send('/cles/connexion/verification', { response: assertion });
    location.href = '/';
  } catch (error) {
    show(error.message);
  }
});
