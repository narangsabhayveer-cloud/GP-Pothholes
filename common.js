// Shared by index.html and admin.html

// Shrinks a photo so it is small enough to send to the server.
// Returns the photo as text (a "data URL") that can be saved and shown later.
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Please choose an image."));
    if (file.size > 10 * 1024 * 1024) return reject(new Error("Photo must be under 10 MB."));

    const img = new Image();
    img.onload = () => {
      // Make the longest side at most 1200 pixels
      const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.78));
    };
    img.onerror = () => reject(new Error("Could not open this image."));
    img.src = URL.createObjectURL(file);
  });
}
