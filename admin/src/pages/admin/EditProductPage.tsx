import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ImageOff, IndianRupee, RefreshCw, Save, ShieldAlert, Trash2, Upload } from 'lucide-react';
import {
  getProductById,
  updateProduct,
  createCategory,
  uploadProductImage,
  getCategories,
  notifyAdminAction,
} from '../../services/adminService';
import { getCurrentAdmin } from '../../services/secureAdminAuth';
import { hasRole } from '../../services/adminAuthService';
import { useToast } from '../../context/ToastContext';
import {
  AdditionalImagesField,
  extraImageUrls,
  toExtraImages,
  type ExtraImage,
} from '../../components/admin/AdditionalImagesField';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  FormField,
  Input,
  LinkButton,
  PageHeader,
  PageLoader,
  Select,
  Spinner,
  Textarea,
  Toggle,
} from '../../components/ui';
import { cn } from '../../utils/cn';
import {
  LOOSE_STEP_KG,
  PIECE_WEIGHT_MAX_G,
  PIECE_WEIGHT_MIN_G,
  parseOrderLimit,
  parsePieceWeight,
  piecePrice,
  validateOrderLimits,
  validatePieceWeight,
} from '../../utils/looseProduct';

/**
 * The main image of a product (master_products.image_url): listings, cart,
 * orders, and first on the product page. Extra photos are a separate list
 * (master_products.additional_images, components/admin/AdditionalImagesField),
 * shown after it on the customer app's product page.
 *
 * (An older gallery UI here uploaded extra photos that were never stored —
 * nothing read or wrote product_images. Extra photos are now a real column.)
 */
interface ImageData {
  id: string;
  url: string;
  isUploading: boolean;
}

// Mirrors the product-images storage bucket configuration.
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Select sentinel that reveals the inline "new category" fields. */
const NEW_CATEGORY = '__NEW_CATEGORY__';

// `color` was removed from the inline category form: the categories table has
// no such column, so a filled-in value made the insert fail.
const EMPTY_NEW_CATEGORY = { name: '', description: '', image_url: '', display_order: '' };

interface FormState {
  name: string;
  price: string;
  original_price: string;
  description: string;
  category: string;
  /** Persisted as master_products.is_active (updateProduct maps in_stock -> is_active). */
  in_stock: boolean;
  rating: string;
  rating_count: string;
  /** master_products.unit (NOT NULL) holds the pack size, e.g. "1kg"; there is no `size` column. */
  unit: string;
  brand: string;
  /** Read-only here: loose items are priced per kg and their quantity limits are kg. */
  is_loose: boolean;
  min_quantity: string;
  max_quantity: string;
  /** Loose items only: grams per piece; blank = sold by weight only. */
  piece_weight_g: string;
  gst_rate: string;
  hsn_code: string;
  hsn_description: string;
  cgst: string;
  sgst: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  price: '',
  original_price: '',
  description: '',
  category: '',
  in_stock: true,
  rating: '0',
  rating_count: '0',
  unit: '',
  brand: '',
  is_loose: false,
  min_quantity: '1',
  max_quantity: '100',
  piece_weight_g: '',
  gst_rate: '',
  hsn_code: '',
  hsn_description: '',
  cgst: '',
  sgst: '',
};

type FieldErrors = Partial<Record<keyof FormState | 'newCategoryName', string>>;

const generateId = () => `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

// Cleared optional fields are sent as null so updateProduct writes NULL; it
// only skips `undefined`, which is why `value || undefined` could never clear.
const textOrNull = (value: string) => (value.trim() ? value.trim() : null);
const numberOrNull = (value: string) => (value.trim() ? parseFloat(value) : null);

/** Human-readable message for save failures, including DB CHECK constraints. */
function describeSaveError(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  const message = e?.message ?? '';
  if (message.includes('check_discounted_price')) {
    return 'Selling price cannot be higher than the original price.';
  }
  if (message.includes('master_products_rating_check')) {
    return 'Rating must be between 0 and 5.';
  }
  // categories.name is UNIQUE (categories_name_key); createCategory rethrows the raw error.
  if (e?.code === '23505' && message.includes('categories')) {
    return 'A category with that name already exists. Pick it from the list instead.';
  }
  return message || 'An error occurred while updating the product.';
}

interface ImageTileProps {
  image: ImageData;
  onRemove: () => void;
}

function ImageTile({ image, onRemove }: ImageTileProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="w-full shrink-0 sm:w-48">
      <div className="relative aspect-square overflow-hidden rounded-md border border-gray-200 bg-gray-50">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center text-gray-400">
            <ImageOff className="h-5 w-5" />
            <span className="mt-2 text-xs">Failed to load</span>
          </div>
        ) : (
          <img
            src={image.url}
            alt="Current product image"
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
        {image.isUploading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/80">
            <Spinner size="sm" />
            <span className="text-xs font-medium text-gray-600">Uploading…</span>
          </div>
        ) : null}
      </div>
      <Button
        variant="dangerOutline"
        size="sm"
        leftIcon={<Trash2 />}
        onClick={onRemove}
        disabled={image.isUploading}
        className="mt-2"
        fullWidth
      >
        Remove image
      </Button>
    </div>
  );
}

const EditProductPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  // getCurrentAdmin parses localStorage; evaluate once instead of every render.
  const canEditProducts = useMemo(() => {
    const admin = getCurrentAdmin();
    return Boolean(admin && hasRole(admin, ['super_admin', 'admin']));
  }, []);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [productName, setProductName] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [showNewCategoryInput, setShowNewCategoryInput] = useState(false);
  const [newCategoryData, setNewCategoryData] = useState(EMPTY_NEW_CATEGORY);
  const [formData, setFormData] = useState<FormState>(EMPTY_FORM);

  const [image, setImage] = useState<ImageData | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  // Extra photos (master_products.additional_images), and the list as loaded,
  // to tell whether saving needs to write them.
  const [extraImages, setExtraImages] = useState<ExtraImage[]>([]);
  const loadedExtrasRef = useRef<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Latest image for the upload pipeline and the unmount cleanup.
  const imageRef = useRef<ImageData | null>(null);
  // Ignores a slow response for a previous :id (or an earlier retry).
  const requestIdRef = useRef(0);

  useEffect(() => {
    imageRef.current = image;
  }, [image]);

  // Revoke a blob preview that is still on screen when the page unmounts.
  useEffect(
    () => () => {
      const current = imageRef.current;
      if (current?.url.startsWith('blob:')) URL.revokeObjectURL(current.url);
    },
    [],
  );

  // Fetch product and categories
  useEffect(() => {
    // The role gate runs before any fetch so unpermitted roles never trigger the queries.
    if (!canEditProducts) {
      setLoading(false);
      return;
    }
    if (!id) {
      setLoadError('Product ID is missing');
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestId === requestIdRef.current;

    const fetchData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [product, categoriesData] = await Promise.all([getProductById(id), getCategories()]);
        if (!isCurrent()) return;

        if (!product) {
          setLoadError('Product not found');
          return;
        }

        setProductName(product.name || '');
        // `!= null` rather than `||` so a 0 price or 0 rating is not coerced away.
        setFormData({
          name: product.name || '',
          price: product.price != null ? String(product.price) : '',
          original_price: product.original_price != null ? String(product.original_price) : '',
          description: product.description || '',
          category: product.category || '',
          in_stock: product.in_stock ?? true,
          rating: product.rating != null ? String(product.rating) : '0',
          rating_count: product.rating_count != null ? String(product.rating_count) : '0',
          unit: product.unit || '',
          brand: product.brand || '',
          is_loose: Boolean(product.isLoose),
          min_quantity: product.min_quantity != null ? String(product.min_quantity) : '1',
          max_quantity: product.max_quantity != null ? String(product.max_quantity) : '100',
          piece_weight_g: product.piece_weight_g != null ? String(product.piece_weight_g) : '',
          gst_rate: product.gst_rate != null ? String(product.gst_rate) : '',
          hsn_code: product.hsn_code || '',
          hsn_description: product.hsn_description || '',
          cgst: product.cgst != null ? String(product.cgst) : '',
          sgst: product.sgst != null ? String(product.sgst) : '',
        });

        setImage(product.image ? { id: 'existing', url: product.image, isUploading: false } : null);
        loadedExtrasRef.current = product.additional_images ?? [];
        setExtraImages(toExtraImages(product.additional_images));
        setCategories(categoriesData.map((cat) => cat.name));
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Error fetching product:', err);
        setLoadError('Failed to load product. Please try again.');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };

    fetchData();
  }, [id, canEditProducts, reloadKey]);

  const clearFieldError = (field: keyof FieldErrors) => {
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    clearFieldError(name as keyof FormState);
  };

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === NEW_CATEGORY) {
      setShowNewCategoryInput(true);
      setFormData((prev) => ({ ...prev, category: '' }));
    } else {
      // Choosing a real category discards any half-typed new-category details.
      setShowNewCategoryInput(false);
      setNewCategoryData(EMPTY_NEW_CATEGORY);
      setFormData((prev) => ({ ...prev, category: value }));
    }
    clearFieldError('category');
    clearFieldError('newCategoryName');
  };

  const handleNewCategoryChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setNewCategoryData((prev) => ({ ...prev, [name]: value }));
    if (name === 'name') clearFieldError('newCategoryName');
  };

  const handleFile = useCallback(async (file: File) => {
    if (imageRef.current?.isUploading) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setImageError(`Unsupported file type: ${file.name}. Use JPG, PNG, WebP or GIF.`);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setImageError(`File too large: ${file.name}. Maximum size is 5MB.`);
      return;
    }
    setImageError(null);

    // Optimistic placeholder: show the local file at once, swap in the public
    // URL when the upload finishes, and put the previous image back if it
    // fails so a failed replacement never wipes the stored image on save.
    const previous = imageRef.current;
    const placeholder: ImageData = { id: generateId(), url: URL.createObjectURL(file), isUploading: true };
    setImage(placeholder);

    let uploadedUrl: string | null = null;
    try {
      uploadedUrl = await uploadProductImage(file);
    } catch (err) {
      console.error('Upload error:', err);
    }

    setImage((current) => {
      // Removed while uploading: leave the user's choice alone.
      if (current?.id !== placeholder.id) return current;
      return uploadedUrl ? { id: placeholder.id, url: uploadedUrl, isUploading: false } : previous;
    });
    // Revoked outside the state updater (updaters may run twice under StrictMode).
    URL.revokeObjectURL(placeholder.url);
    if (!uploadedUrl) {
      setImageError(previous ? 'Upload failed. The previous image was kept.' : 'Upload failed. Please try again.');
    }
  }, []);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!image?.isUploading) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // dragleave also fires when moving between the zone's own children; ignore those.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so picking the same file again re-triggers onChange.
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeImage = () => {
    if (!image || image.isUploading) return;
    if (image.url.startsWith('blob:')) URL.revokeObjectURL(image.url);
    setImage(null);
    setImageError(null);
  };

  // Swap an extra photo with the main image: the chosen photo becomes the
  // main one and the old main image takes its place in the list (or it just
  // leaves the list when there was no main image).
  const makeExtraMain = (extra: ExtraImage) => {
    if (extra.isUploading || image?.isUploading) return;
    const previousMain = image;
    setImage({ id: generateId(), url: extra.url, isUploading: false });
    setExtraImages((prev) => {
      const index = prev.findIndex((p) => p.id === extra.id);
      if (index < 0) return prev;
      const next = [...prev];
      if (previousMain) next[index] = { id: generateId(), url: previousMain.url, isUploading: false };
      else next.splice(index, 1);
      return next;
    });
    setImageError(null);
  };

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    const price = parseFloat(formData.price);
    const originalPrice = formData.original_price.trim() ? parseFloat(formData.original_price) : null;

    if (!formData.name.trim()) errors.name = 'Product name is required';
    if (!formData.price.trim() || Number.isNaN(price) || price <= 0) errors.price = 'Valid price is required';
    // master_products enforces discounted_price <= base_price; checked here so
    // the admin sees a readable message instead of a raw constraint violation.
    if (originalPrice != null && !Number.isNaN(price) && originalPrice < price) {
      errors.original_price = 'Original price must be at least the selling price';
    }
    if (!formData.category && !showNewCategoryInput) errors.category = 'Category is required';
    if (showNewCategoryInput && !newCategoryData.name.trim()) errors.newCategoryName = 'New category name is required';
    if (!formData.unit.trim()) errors.unit = 'Unit is required';

    // Loose items' limits are kg in 50 g steps (0.05); whole numbers otherwise.
    Object.assign(errors, validateOrderLimits(formData.min_quantity, formData.max_quantity, formData.is_loose));
    if (formData.is_loose) {
      const pieceError = validatePieceWeight(formData.piece_weight_g);
      if (pieceError) errors.piece_weight_g = pieceError;
    }
    for (const field of ['gst_rate', 'cgst', 'sgst'] as const) {
      const raw = formData[field].trim();
      if (!raw) continue;
      const value = parseFloat(raw);
      if (Number.isNaN(value) || value < 0 || value > 100) errors[field] = 'Enter a percentage between 0 and 100';
    }
    return errors;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || saving) return;

    setError(null);

    const errors = validate();
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      setFieldErrors(errors);
      setError('Please correct the highlighted fields.');
      // The Save button sits at the bottom of a long form; move focus to the
      // first invalid control (ids match the FieldErrors keys) so the error is
      // seen and announced instead of being left off-screen at the top.
      requestAnimationFrame(() => document.getElementById(firstInvalid)?.focus());
      return;
    }
    setFieldErrors({});

    if (image?.isUploading || extraImages.some((i) => i.isUploading)) {
      setError('Please wait for the photos to finish uploading');
      return;
    }

    setSaving(true);
    try {
      // Inline category creation runs only after validation passes. Once it
      // succeeds the new category is selected like any existing one, so a
      // failed product update can be retried without creating it twice.
      let categoryToUse = formData.category;
      if (showNewCategoryInput && newCategoryData.name.trim()) {
        const newCategory = await createCategory({
          name: newCategoryData.name.trim(),
          description: newCategoryData.description.trim() || undefined,
          image_url: newCategoryData.image_url.trim() || undefined,
          display_order: newCategoryData.display_order ? parseInt(newCategoryData.display_order, 10) : undefined,
        });
        if (!newCategory) {
          setError('Failed to create new category. Please try again.');
          return;
        }
        categoryToUse = newCategory.name;
        setCategories((prev) => (prev.includes(newCategory.name) ? prev : [...prev, newCategory.name].sort()));
        setFormData((prev) => ({ ...prev, category: newCategory.name }));
        setShowNewCategoryInput(false);
        setNewCategoryData(EMPTY_NEW_CATEGORY);
      }

      const price = parseFloat(formData.price);
      // Extra photos are only written when the list changed, so saving a
      // product whose photos weren't touched never depends on that column.
      const extraUrls = extraImageUrls(extraImages);
      const loadedExtras = loadedExtrasRef.current;
      const extrasChanged =
        extraUrls.length !== loadedExtras.length || extraUrls.some((url, i) => url !== loadedExtras[i]);
      const productData = {
        name: formData.name.trim(),
        price,
        // base_price is NOT NULL: a blank MRP means "no discount", i.e. equal to the price.
        original_price: formData.original_price.trim() ? parseFloat(formData.original_price) : price,
        description: textOrNull(formData.description),
        // null, not undefined, so removing the image is persisted (updateProduct skips undefined).
        image: image && !image.isUploading ? image.url : null,
        ...(extrasChanged ? { additional_images: extraUrls } : {}),
        category: categoryToUse,
        in_stock: formData.in_stock,
        // rating / rating_count are deliberately not sent: they come only from
        // published customer reviews (recompute_master_product_rating trigger).
        // Typed-in ratings were how 41k products ended up with fake stars.
        // Never default to 'piece' here: that overwrote every product's real unit on edit.
        unit: formData.unit.trim(),
        brand: textOrNull(formData.brand),
        min_quantity: parseOrderLimit(formData.min_quantity, formData.is_loose),
        max_quantity: parseOrderLimit(formData.max_quantity, formData.is_loose),
        // Only loose items carry a piece weight; others leave the column alone.
        ...(formData.is_loose ? { piece_weight_g: parsePieceWeight(formData.piece_weight_g) } : {}),
        gst_rate: numberOrNull(formData.gst_rate),
        hsn_code: textOrNull(formData.hsn_code),
        hsn_description: textOrNull(formData.hsn_description),
        cgst: numberOrNull(formData.cgst),
        sgst: numberOrNull(formData.sgst),
      };

      // ProductUpdate accepts null for the nullable columns (= clear) and
      // treats undefined as "leave unchanged".
      const result = await updateProduct(id, productData);

      if (result) {
        await notifyAdminAction('updated product', productData.name, { product_id: id, product_name: productData.name });
        showToast('Product updated', 'success');
        navigate('/products');
      } else {
        setError('Failed to update product. Please try again.');
      }
    } catch (err) {
      console.error('Error updating product:', err);
      setError(describeSaveError(err));
    } finally {
      setSaving(false);
    }
  };

  // Same title and description in every state so loading -> loaded does not shift the layout.
  const description = productName
    ? `Update the master catalog entry for ${productName}; changes apply in every store.`
    : 'Update the master catalog entry; changes apply in every store.';
  const header = (
    <PageHeader title="Edit product" description={description} backTo="/products" backLabel="Back to products" />
  );

  if (!canEditProducts) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState
            icon={ShieldAlert}
            title="Not permitted"
            description="Only super admins and admins can edit catalog products."
            action={
              <LinkButton to="/products" variant="secondary">
                Back to products
              </LinkButton>
            }
          />
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        {header}
        <PageLoader label="Loading product…" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Alert
          tone="danger"
          title="Could not load product"
          actions={
            <>
              {id ? (
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<RefreshCw />}
                  onClick={() => setReloadKey((key) => key + 1)}
                >
                  Retry
                </Button>
              ) : null}
              <LinkButton to="/products" variant="secondary" size="sm">
                Back to products
              </LinkButton>
            </>
          }
        >
          {loadError}
        </Alert>
      </div>
    );
  }

  const uploading = Boolean(image?.isUploading) || extraImages.some((i) => i.isUploading);
  // A stored category that is no longer in the categories table would make the
  // select fall back to "Select a category" while the hidden value still saves.
  const staleCategory = formData.category && !categories.includes(formData.category) ? formData.category : null;

  return (
    <div className="space-y-6">
      {header}

      {error ? (
        <Alert tone="danger" title="Product not saved" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="max-w-4xl space-y-6">
        <Card>
          <CardHeader title="Basic information" description="Name, category and description shown to customers." />
          <CardBody className="grid gap-5 md:grid-cols-2">
            <FormField label="Product name" htmlFor="name" required error={fieldErrors.name} className="md:col-span-2">
              <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                required
                invalid={Boolean(fieldErrors.name)}
                placeholder="e.g. Organic Basmati Rice"
              />
            </FormField>

            <div className="md:col-span-2">
              <FormField label="Category" htmlFor="category" required error={fieldErrors.category}>
                <Select
                  id="category"
                  name="category"
                  value={showNewCategoryInput ? NEW_CATEGORY : formData.category}
                  onChange={handleCategoryChange}
                  required={!showNewCategoryInput}
                  invalid={Boolean(fieldErrors.category)}
                >
                  <option value="">Select a category</option>
                  <option value={NEW_CATEGORY}>Create new category</option>
                  {staleCategory ? <option value={staleCategory}>{staleCategory} (not in category list)</option> : null}
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </Select>
              </FormField>

              {showNewCategoryInput ? (
                <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm font-medium text-gray-900">New category</p>
                  <p className="mt-0.5 text-xs text-gray-500">Created when you save the product.</p>
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <FormField
                      label="Category name"
                      htmlFor="newCategoryName"
                      required
                      error={fieldErrors.newCategoryName}
                    >
                      <Input
                        id="newCategoryName"
                        name="name"
                        value={newCategoryData.name}
                        onChange={handleNewCategoryChange}
                        required
                        invalid={Boolean(fieldErrors.newCategoryName)}
                        placeholder="e.g. Vegetables, Fruits, Dairy"
                      />
                    </FormField>
                    <FormField label="Display order" htmlFor="newCategoryDisplayOrder" hint="Lower numbers appear first">
                      <Input
                        type="number"
                        id="newCategoryDisplayOrder"
                        name="display_order"
                        value={newCategoryData.display_order}
                        onChange={handleNewCategoryChange}
                        min={0}
                        step={1}
                        placeholder="1, 2, 3…"
                      />
                    </FormField>
                    <FormField label="Image URL" htmlFor="newCategoryImageUrl" className="md:col-span-2">
                      <Input
                        type="url"
                        id="newCategoryImageUrl"
                        name="image_url"
                        value={newCategoryData.image_url}
                        onChange={handleNewCategoryChange}
                        placeholder="https://example.com/category-image.jpg"
                      />
                    </FormField>
                    <FormField label="Description" htmlFor="newCategoryDescription" className="md:col-span-2">
                      <Textarea
                        id="newCategoryDescription"
                        name="description"
                        value={newCategoryData.description}
                        onChange={handleNewCategoryChange}
                        rows={2}
                        placeholder="Enter category description…"
                      />
                    </FormField>
                  </div>
                </div>
              ) : null}
            </div>

            <FormField label="Description" htmlFor="description" className="md:col-span-2">
              <Textarea
                id="description"
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={3}
                placeholder="Enter product description…"
              />
            </FormField>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Main image"
            description="Shown in listings, the cart and orders, and first on the product page."
          />
          <CardBody>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              onChange={handleFileInputChange}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
            <FormField error={imageError ?? undefined}>
              <div className="flex flex-col gap-5 sm:flex-row">
                {image ? <ImageTile key={image.id} image={image} onRemove={removeImage} /> : null}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  disabled={Boolean(image?.isUploading)}
                  aria-describedby="product-image-hint"
                  className={cn(
                    'flex min-h-[12rem] flex-1 flex-col items-center justify-center rounded-md border-2 border-dashed px-6 py-8 text-center transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    isDragging
                      ? 'border-brand-500 bg-brand-50'
                      : 'border-gray-300 bg-white hover:border-brand-400 hover:bg-gray-50',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-md',
                      isDragging ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500',
                    )}
                  >
                    <Upload className="h-5 w-5" />
                  </span>
                  <span className="mt-3 text-sm font-medium text-gray-900">
                    {isDragging
                      ? 'Drop the image here'
                      : image
                        ? 'Drop a new image to replace the current one'
                        : 'Drag and drop an image here'}
                  </span>
                  <span className="mt-1 text-sm text-gray-500">or click to browse</span>
                  <span id="product-image-hint" className="mt-3 text-xs text-gray-500">
                    JPG, PNG, WebP or GIF, up to 5MB
                  </span>
                </button>
              </div>
            </FormField>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="More photos"
            description="Optional. Customers swipe through these after the main image on the app's product page."
          />
          <CardBody>
            <AdditionalImagesField images={extraImages} setImages={setExtraImages} onMakeMain={makeExtraMain} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Pricing and details" description="Prices are in rupees and apply to every store." />
          <CardBody className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            <FormField label="Price" htmlFor="price" required error={fieldErrors.price}>
              <Input
                type="number"
                id="price"
                name="price"
                value={formData.price}
                onChange={handleChange}
                required
                min={0}
                step="0.01"
                inputMode="decimal"
                invalid={Boolean(fieldErrors.price)}
                leftIcon={<IndianRupee />}
                placeholder="0.00"
              />
            </FormField>
            <FormField
              label="Original price"
              htmlFor="original_price"
              hint="MRP before discount. Leave blank when there is no discount."
              error={fieldErrors.original_price}
            >
              <Input
                type="number"
                id="original_price"
                name="original_price"
                value={formData.original_price}
                onChange={handleChange}
                min={0}
                step="0.01"
                inputMode="decimal"
                invalid={Boolean(fieldErrors.original_price)}
                leftIcon={<IndianRupee />}
                placeholder="0.00"
              />
            </FormField>
            <FormField
              label="Unit / size"
              htmlFor="unit"
              required
              hint={formData.is_loose ? 'Loose item: the price is per kg, so the unit is "kg"' : 'e.g. 1kg, 500ml, piece'}
              error={fieldErrors.unit}
            >
              <Input
                id="unit"
                name="unit"
                value={formData.unit}
                onChange={handleChange}
                required
                invalid={Boolean(fieldErrors.unit)}
                placeholder="e.g. 1kg"
              />
            </FormField>
            <FormField label="Brand" htmlFor="brand">
              <Input id="brand" name="brand" value={formData.brand} onChange={handleChange} placeholder="e.g. Amul" />
            </FormField>

            <FormField
              label="Customer rating"
              htmlFor="rating"
              hint="Calculated from published customer reviews, so it can't be edited here."
            >
              <Input
                id="rating"
                value={
                  Number(formData.rating_count) > 0
                    ? `${Number(formData.rating).toFixed(1)} ★ from ${formData.rating_count} review${formData.rating_count === '1' ? '' : 's'}`
                    : 'No reviews yet'
                }
                readOnly
                disabled
              />
            </FormField>
            <FormField
              label={formData.is_loose ? 'Min order quantity (kg)' : 'Min order quantity'}
              htmlFor="min_quantity"
              required
              hint={formData.is_loose ? 'Loose item: kg in 50 g steps, e.g. 0.05' : undefined}
              error={fieldErrors.min_quantity}
            >
              <Input
                type="number"
                id="min_quantity"
                name="min_quantity"
                value={formData.min_quantity}
                onChange={handleChange}
                required
                min={formData.is_loose ? LOOSE_STEP_KG : 1}
                step={formData.is_loose ? LOOSE_STEP_KG : 1}
                inputMode={formData.is_loose ? 'decimal' : 'numeric'}
                invalid={Boolean(fieldErrors.min_quantity)}
                placeholder={formData.is_loose ? '0.05' : '1'}
              />
            </FormField>
            <FormField
              label={formData.is_loose ? 'Max order quantity (kg)' : 'Max order quantity'}
              htmlFor="max_quantity"
              required
              error={fieldErrors.max_quantity}
            >
              <Input
                type="number"
                id="max_quantity"
                name="max_quantity"
                value={formData.max_quantity}
                onChange={handleChange}
                required
                min={formData.is_loose ? LOOSE_STEP_KG : 1}
                step={formData.is_loose ? LOOSE_STEP_KG : 1}
                inputMode={formData.is_loose ? 'decimal' : 'numeric'}
                invalid={Boolean(fieldErrors.max_quantity)}
                placeholder={formData.is_loose ? '10' : '100'}
              />
            </FormField>
            {formData.is_loose ? (
              <FormField
                label="Weight per piece (g)"
                htmlFor="piece_weight_g"
                className="md:col-span-2"
                hint={
                  formData.piece_weight_g.trim() && !fieldErrors.piece_weight_g && Number(formData.price) > 0
                    ? `Customers can also buy by the piece at ₹${piecePrice(Number(formData.price), Number(formData.piece_weight_g))} each. Leave blank to sell by weight only.`
                    : 'Average weight of one piece, e.g. 180 for an apple. Lets customers buy by the piece at a fixed price. Leave blank to sell by weight only.'
                }
                error={fieldErrors.piece_weight_g}
              >
                <Input
                  type="number"
                  id="piece_weight_g"
                  name="piece_weight_g"
                  value={formData.piece_weight_g}
                  onChange={handleChange}
                  min={PIECE_WEIGHT_MIN_G}
                  max={PIECE_WEIGHT_MAX_G}
                  step={1}
                  inputMode="numeric"
                  invalid={Boolean(fieldErrors.piece_weight_g)}
                  placeholder="Sold by weight only"
                />
              </FormField>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Tax and HSN" description="Used on invoices. Leave blank for products without GST." />
          <CardBody className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            <FormField label="GST rate (%)" htmlFor="gst_rate" error={fieldErrors.gst_rate}>
              <Input
                type="number"
                id="gst_rate"
                name="gst_rate"
                value={formData.gst_rate}
                onChange={handleChange}
                min={0}
                max={100}
                step="0.01"
                inputMode="decimal"
                invalid={Boolean(fieldErrors.gst_rate)}
                placeholder="e.g. 18"
              />
            </FormField>
            <FormField label="CGST (%)" htmlFor="cgst" error={fieldErrors.cgst}>
              <Input
                type="number"
                id="cgst"
                name="cgst"
                value={formData.cgst}
                onChange={handleChange}
                min={0}
                max={100}
                step="0.01"
                inputMode="decimal"
                invalid={Boolean(fieldErrors.cgst)}
                placeholder="e.g. 9"
              />
            </FormField>
            <FormField label="SGST (%)" htmlFor="sgst" error={fieldErrors.sgst}>
              <Input
                type="number"
                id="sgst"
                name="sgst"
                value={formData.sgst}
                onChange={handleChange}
                min={0}
                max={100}
                step="0.01"
                inputMode="decimal"
                invalid={Boolean(fieldErrors.sgst)}
                placeholder="e.g. 9"
              />
            </FormField>
            <FormField label="HSN code" htmlFor="hsn_code">
              <Input id="hsn_code" name="hsn_code" value={formData.hsn_code} onChange={handleChange} placeholder="e.g. 1905" />
            </FormField>
            <FormField label="HSN description" htmlFor="hsn_description" className="md:col-span-2 lg:col-span-4">
              <Input
                id="hsn_description"
                name="hsn_description"
                value={formData.hsn_description}
                onChange={handleChange}
                placeholder="e.g. Bread, pastry, cakes"
              />
            </FormField>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Availability" />
          <CardBody>
            {/* Writes master_products.is_active (ProductsPage toggles the same flag);
                per-store stock lives in store_products, so this is "listed", not "in stock". */}
            <Toggle
              id="is_active"
              checked={formData.in_stock}
              onChange={(next) => setFormData((prev) => ({ ...prev, in_stock: next }))}
              label="Active in catalog"
              description="Inactive products are hidden from every store and cannot be ordered. Per-store stock is managed in store inventory."
            />
          </CardBody>
          <CardFooter className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => navigate('/products')} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={uploading} leftIcon={<Save />}>
              {uploading ? 'Uploading photos…' : 'Save changes'}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
};

export default EditProductPage;
