// Shrinks a chosen photo before upload; any failure leaves the original file untouched.
const input = document.querySelector('input[name=photo]');
if (input) {
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file || !window.createImageBitmap || !window.DataTransfer) return;
    // No submit while compressing, or the original would be sent.
    const buttons = input.form ? [...input.form.querySelectorAll('button[type=submit], input[type=submit], button:not([type])')] : [];
    for (const button of buttons) button.disabled = true;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      let blob = null;
      for (const quality of [0.8, 0.6, 0.4]) {
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob || blob.size <= 1024 * 1024) break;
      }
      if (!blob) return;
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      input.files = transfer.files;
    } catch (error) {
      // Keep the original file.
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  });
}
