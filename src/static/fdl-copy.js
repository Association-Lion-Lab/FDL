const message = document.getElementById('copy-message');
document.getElementById('copy').addEventListener('click', async () => {
  const field = document.getElementById('link');
  try {
    await navigator.clipboard.writeText(field.value);
    message.textContent = 'Lien copié.';
  } catch {
    field.select();
    message.textContent = 'Copiez le lien sélectionné (Ctrl+C).';
  }
});
