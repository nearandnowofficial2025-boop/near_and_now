import { useEffect, useRef, useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { ArrowLeft, ArrowRight, ImageOff, ImagePlus, Star, Trash2 } from 'lucide-react';
import { MAX_ADDITIONAL_IMAGES, uploadProductImage } from '../../services/adminService';
import { FormField, IconButton, Spinner, Tooltip } from '../ui';
import { cn } from '../../utils/cn';

/**
 * "More photos" for a product: master_products.additional_images, the extra
 * photos the customer app's product page shows after the main image
 * (image_url). Used by AddProductPage and EditProductPage, which own the list
 * so they can block saving while a photo uploads and swap a photo with the
 * main image.
 */
export interface ExtraImage {
  id: string;
  /** Public URL once uploaded; a local blob: preview while uploading. */
  url: string;
  isUploading: boolean;
}

// Same rules as the main image (the product-images storage bucket).
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const newId = () => `extra_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

/** ExtraImage tiles for the URLs stored on a product. */
export function toExtraImages(urls: readonly string[] | null | undefined): ExtraImage[] {
  return (urls ?? []).map((url) => ({ id: newId(), url, isUploading: false }));
}

/** The URLs to save. Callers block saving while `isUploading` is true for any of them. */
export function extraImageUrls(images: readonly ExtraImage[]): string[] {
  return images.filter((i) => !i.isUploading).map((i) => i.url);
}

interface AdditionalImagesFieldProps {
  images: ExtraImage[];
  setImages: Dispatch<SetStateAction<ExtraImage[]>>;
  /** Make this photo the main image (the page swaps it with the current one). */
  onMakeMain?: (image: ExtraImage) => void;
  disabled?: boolean;
}

export function AdditionalImagesField({ images, setImages, onMakeMain, disabled = false }: AdditionalImagesFieldProps) {
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke blob previews still on screen when the page unmounts.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(
    () => () => {
      for (const img of imagesRef.current) if (img.url.startsWith('blob:')) URL.revokeObjectURL(img.url);
    },
    [],
  );

  const slotsLeft = MAX_ADDITIONAL_IMAGES - images.length;
  const anyUploading = images.some((i) => i.isUploading);

  const addFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      if (!ACCEPTED_TYPES.includes(file.type)) problems.push(`${file.name}: use JPG, PNG, WebP or GIF`);
      else if (file.size > MAX_FILE_SIZE) problems.push(`${file.name}: larger than 5MB`);
      else accepted.push(file);
    }
    const room = Math.max(0, MAX_ADDITIONAL_IMAGES - imagesRef.current.length);
    if (accepted.length > room) {
      problems.push(
        room === 0
          ? `A product can have at most ${MAX_ADDITIONAL_IMAGES} extra photos.`
          : `Only ${room} more photo${room === 1 ? '' : 's'} can be added (${MAX_ADDITIONAL_IMAGES} at most).`,
      );
      accepted.length = room;
    }
    setError(problems.length ? problems.join(' · ') : null);
    if (accepted.length === 0) return;

    const placeholders = accepted.map((file) => ({ id: newId(), url: URL.createObjectURL(file), isUploading: true }));
    setImages((prev) => [...prev, ...placeholders]);

    placeholders.forEach((placeholder, i) => {
      const file = accepted[i];
      void uploadProductImage(file).then((uploadedUrl) => {
        URL.revokeObjectURL(placeholder.url);
        setImages((prev) => {
          // Removed while uploading: leave the user's choice alone.
          if (!prev.some((p) => p.id === placeholder.id)) return prev;
          return uploadedUrl
            ? prev.map((p) => (p.id === placeholder.id ? { id: p.id, url: uploadedUrl, isUploading: false } : p))
            : prev.filter((p) => p.id !== placeholder.id);
        });
        if (!uploadedUrl) {
          setError((prevError) => [prevError, `${file.name}: upload failed, please try again`].filter(Boolean).join(' · '));
        }
      });
    });
  };

  const move = (index: number, delta: -1 | 1) => {
    setImages((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const remove = (id: string) => {
    setImages((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone?.url.startsWith('blob:')) URL.revokeObjectURL(gone.url);
      return prev.filter((p) => p.id !== id);
    });
    setError(null);
  };

  const canAdd = !disabled && slotsLeft > 0;

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (canAdd) addFiles(e.dataTransfer.files);
  };

  return (
    <FormField error={error ?? undefined}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES.join(',')}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((image, index) => (
          <ExtraImageTile
            key={image.id}
            image={image}
            position={index + 1}
            isFirst={index === 0}
            isLast={index === images.length - 1}
            disabled={disabled}
            onMoveEarlier={() => move(index, -1)}
            onMoveLater={() => move(index, 1)}
            onRemove={() => remove(image.id)}
            onMakeMain={onMakeMain && !image.isUploading ? () => onMakeMain(image) : undefined}
          />
        ))}
        {canAdd ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={onDrop}
            aria-describedby="more-photos-hint"
            className={cn(
              'flex aspect-square flex-col items-center justify-center rounded-md border-2 border-dashed px-3 text-center transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
              isDragging ? 'border-brand-500 bg-brand-50' : 'border-gray-300 bg-white hover:border-brand-400 hover:bg-gray-50',
            )}
          >
            <ImagePlus className="h-5 w-5 text-gray-500" aria-hidden="true" />
            <span className="mt-2 text-sm font-medium text-gray-900">{isDragging ? 'Drop photos here' : 'Add photos'}</span>
            <span className="mt-1 text-xs text-gray-500">
              {slotsLeft} of {MAX_ADDITIONAL_IMAGES} left
            </span>
          </button>
        ) : null}
      </div>
      <p id="more-photos-hint" className="mt-2 text-xs text-gray-500">
        JPG, PNG, WebP or GIF, up to 5MB each. Shown after the main image, in this order, on the customer app&apos;s
        product page.
        {anyUploading ? ' Uploading…' : ''}
      </p>
    </FormField>
  );
}

interface ExtraImageTileProps {
  image: ExtraImage;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  onRemove: () => void;
  onMakeMain?: () => void;
}

function ExtraImageTile({
  image,
  position,
  isFirst,
  isLast,
  disabled,
  onMoveEarlier,
  onMoveLater,
  onRemove,
  onMakeMain,
}: ExtraImageTileProps) {
  const [failed, setFailed] = useState(false);
  const locked = disabled || image.isUploading;

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-md border border-gray-200 bg-gray-50">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center text-gray-400">
            <ImageOff className="h-5 w-5" aria-hidden="true" />
            <span className="mt-2 text-xs">Failed to load</span>
          </div>
        ) : (
          <img
            src={image.url}
            alt={`Extra photo ${position}`}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-white/90 px-1.5 text-xs font-medium text-gray-700">
          {position}
        </span>
        {image.isUploading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/80">
            <Spinner size="sm" />
            <span className="text-xs font-medium text-gray-600">Uploading…</span>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-1">
        <div className="flex gap-1">
          <Tooltip content="Move earlier">
            <IconButton
              size="sm"
              variant="secondary"
              aria-label={`Move photo ${position} earlier`}
              onClick={onMoveEarlier}
              disabled={locked || isFirst}
            >
              <ArrowLeft />
            </IconButton>
          </Tooltip>
          <Tooltip content="Move later">
            <IconButton
              size="sm"
              variant="secondary"
              aria-label={`Move photo ${position} later`}
              onClick={onMoveLater}
              disabled={locked || isLast}
            >
              <ArrowRight />
            </IconButton>
          </Tooltip>
        </div>
        <div className="flex gap-1">
          {onMakeMain ? (
            <Tooltip content="Make main image">
              <IconButton
                size="sm"
                variant="secondary"
                aria-label={`Make photo ${position} the main image`}
                onClick={onMakeMain}
                disabled={locked}
              >
                <Star />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip content="Remove">
            <IconButton
              size="sm"
              variant="danger"
              aria-label={`Remove photo ${position}`}
              onClick={onRemove}
              disabled={disabled}
            >
              <Trash2 />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
