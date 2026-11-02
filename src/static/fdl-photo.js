// Shrinks a chosen photo before upload; any failure leaves the original file untouched.
const input = document.querySelector('input[name=photo]');
if (input) {
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file || !window.createImageBitmap || !window.DataTransfer) return;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!blob) return;
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      input.files = transfer.files;
    } catch (error) {
      // Keep the original file.
    }
  });
}
