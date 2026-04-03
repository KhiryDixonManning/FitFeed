import { useState } from "react";
import Headbar from "../components/Headbar";

export default function Upload() {
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState("");

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPreview(URL.createObjectURL(file));
    }
  };

  const handlePublish = () => {
    // Firebase upload logic will go here
  };

  return (
    <div>
      <Headbar />
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="flex flex-row items-start gap-8 p-8">

          {/* Preview */}
          <div className="w-80 h-80 bg-gray-200 rounded-2xl flex items-center justify-center shadow-md overflow-hidden">
            {preview ? (
              <img src={preview} alt="Preview" className="w-full h-full object-cover" />
            ) : (
              //place svg here
              null
            )}
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-4 w-64">

            {/* Choose Photo Button */}
            <label className="cursor-pointer">
              <span className="block text-center text-white font-semibold py-2 px-4 rounded-full bg-gradient-to-r from-pink-500 to-blue-400 hover:opacity-90 transition">
                Choose a Photo
              </span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePhotoChange}
              />
            </label>

            {/* Caption Input */}
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Enter a caption here"
              className="w-full h-48 p-3 border border-gray-300 rounded-lg resize-none text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-pink-300"
            />

            {/* Publish Button */}
            <button
              onClick={handlePublish}
              className="text-white font-semibold py-2 px-4 rounded-full bg-gradient-to-r from-pink-500 to-blue-400 hover:opacity-90 transition"
            >
              Publish
            </button>

          </div>
        </div>
      </div>
    </div>
  );
}