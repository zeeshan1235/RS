// Firebase Imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    setDoc, 
    collection, 
    onSnapshot, 
    deleteDoc, 
    addDoc,
    query
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Firestore logging is enabled for debugging
setLogLevel('Debug');

// Global Firebase Variables (Provided by Canvas Environment)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// --- Core Configuration ---
const ADMIN_PIN = '2014'; // یہ ایڈمن پن کوڈ ہے
const PRODUCTS_COLLECTION_PATH = `/artifacts/${appId}/public/data/fashion_chips_products`;
const ORDERS_COLLECTION_PATH = `/artifacts/${appId}/public/data/fashion_chips_orders`;
const CART_KEY = 'fashionChipsCart';
const MIN_PICKUP_TIME_MINUTES = 20; // کم از کم پک اپ کا وقت

// Firestore and Auth instances
let app, db, auth;
let userId = null;
let isAdmin = false;

// State Management
let products = [];
let cart = loadCart();
let orders = [];

// --- Utility Functions ---

/**
 * Loads the cart from local storage.
 * @returns {Array} The cart items.
 */
function loadCart() {
    try {
        const storedCart = localStorage.getItem(CART_KEY);
        return storedCart ? JSON.parse(storedCart) : [];
    } catch (e) {
        console.error("Error loading cart from storage:", e);
        return [];
    }
}

/**
 * Saves the current cart state to local storage and re-renders the app.
 */
function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    renderApp();
}

/**
 * Formats the price to UK Pound Sterling.
 * @param {number} price 
 * @returns {string} Formatted price string.
 */
function formatPrice(price) {
    return `£${price.toFixed(2)}`;
}

/**
 * Calculates the earliest possible pickup time (now + minimum prep time).
 * @returns {string} Time string in "HH:MM" format.
 */
function getEarliestTime() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + MIN_PICKUP_TIME_MINUTES); 
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes() + 5 - (now.getMinutes() % 5)).padStart(2, '0'); // Round to nearest 5 mins
    return `${hour}:${minute}`;
}

/**
 * Custom Modal for Alerts, Confirms, and Prompts (replaces native functions)
 * @param {string} message - Message to display.
 * @param {string} title - Modal title.
 * @param {boolean} isConfirm - If true, shows Cancel button.
 * @param {boolean} isPrompt - If true, shows an input field.
 * @returns {Promise<boolean|string|null>} - Resolves to boolean (confirm), string (prompt), or null (cancel).
 */
function showModal(message, title = "پیغام", isConfirm = false, isPrompt = false) {
    return new Promise(resolve => {
        const modal = document.getElementById('custom-modal');
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-message').textContent = message;
        
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');
        const inputField = document.getElementById('modal-input');

        inputField.classList.add('hidden');
        cancelBtn.classList.add('hidden');
        
        if (isPrompt) {
            inputField.type = 'password'; // Use password type for PIN
            inputField.value = '';
            inputField.classList.remove('hidden');
            cancelBtn.classList.remove('hidden');
        } else if (isConfirm) {
            cancelBtn.classList.remove('hidden');
        }
        
        modal.classList.remove('hidden');

        const onConfirm = () => {
            modal.classList.add('hidden');
            resolve(isPrompt ? inputField.value : true);
            cleanupListeners();
        };

        const onCancel = () => {
            modal.classList.add('hidden');
            resolve(false);
            cleanupListeners();
        };
        
        // Add listeners
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);

        // Cleanup listeners after resolution
        const cleanupListeners = () => {
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        };
    });
}

// --- Firebase Initialization ---

async function initFirebase() {
    try {
        if (Object.keys(firebaseConfig).length === 0) {
            throw new Error("Firebase Configuration is missing.");
        }

        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);

        // Initial sign-in logic
        if (initialAuthToken) {
            await signInWithCustomToken(auth, initialAuthToken);
        } else {
            await signInAnonymously(auth);
        }

        // Listen for authentication state changes
        onAuthStateChanged(auth, (user) => {
            if (user) {
                userId = user.uid;
                console.log("Firebase Auth Ready. User ID:", userId);
                startAppListeners();
            } else {
                console.log("User signed out or anonymous.");
                if (!userId) {
                    userId = crypto.randomUUID(); // Fallback
                }
                startAppListeners();
            }
            document.getElementById('loading-spinner').classList.add('hidden');
            document.getElementById('app-container').classList.remove('hidden');
        });

    } catch (error) {
        console.error("Firebase initialization failed:", error);
        showModal(`Firebase شروع کرنے میں ناکام رہا: ${error.message}`, "غلطی");
        document.getElementById('loading-spinner').classList.add('hidden');
    }
}

// --- Real-time Listeners (onSnapshot) ---

function startAppListeners() {
    if (!db || !userId) return; // Wait for Firebase to initialize

    // 1. Listen to Products
    onSnapshot(collection(db, PRODUCTS_COLLECTION_PATH), (snapshot) => {
        products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log("Products updated:", products.length);
        renderApp();
    }, (error) => {
        console.error("Error listening to products:", error);
    });

    // 2. Listen to Orders
    onSnapshot(collection(db, ORDERS_COLLECTION_PATH), (snapshot) => {
        orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Sort to show Pending orders first
        orders.sort((a, b) => {
            if (a.status === 'Pending' && b.status !== 'Pending') return -1;
            if (a.status !== 'Pending' && b.status === 'Pending') return 1;
            return new Date(b.orderTime) - new Date(a.orderTime); // Latest first
        });
        console.log("Orders updated:", orders.length);
        renderApp();
    }, (error) => {
        console.error("Error listening to orders:", error);
    });
}

// --- Customer Functions ---

/**
 * Adds a product to the shopping cart.
 * @param {string} productId 
 */
window.addToCart = function(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const existingItem = cart.find(item => item.id === productId);
    if (existingItem) {
        existingItem.quantity++;
    } else {
        cart.push({ ...product, quantity: 1 });
    }
    saveCart();
    showModal(`${product.name} ٹوکری میں شامل کر دیا گیا ہے۔`, "کامیابی");
}

/**
 * Updates the quantity of an item in the cart.
 * @param {string} productId 
 * @param {number} delta - +1 or -1
 */
window.updateCartQuantity = function(productId, delta) {
    const item = cart.find(item => item.id === productId);
    if (!item) return;

    item.quantity += delta;
    if (item.quantity <= 0) {
        cart = cart.filter(item => item.id !== productId);
    }
    saveCart();
}

/**
 * Submits the customer order to Firestore.
 */
window.submitOrder = async function() {
    const pickupTimeInput = document.getElementById('pickup-time-input');
    const pickupTime = pickupTimeInput.value;

    if (cart.length === 0) {
        showModal("آرڈر بھیجنے کے لیے براہ کرم کچھ اشیاء ٹوکری میں شامل کریں۔", "ضروری");
        return;
    }
    if (!pickupTime) {
        showModal("براہ کرم پک اپ کا وقت منتخب کریں۔", "ضروری");
        return;
    }

    // Simple validation for time (must be in the future, based on min prep time)
    const [h, m] = pickupTime.split(':').map(Number);
    const selectedTime = new Date();
    selectedTime.setHours(h, m, 0, 0);
    const earliestTime = new Date();
    earliestTime.setMinutes(earliestTime.getMinutes() + MIN_PICKUP_TIME_MINUTES);
    
    // Reset date part to compare only time difference today
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const selectedTimeToday = new Date(today);
    selectedTimeToday.setHours(h, m, 0, 0);

    if (selectedTimeToday.getTime() < earliestTime.getTime()) {
        showModal(`براہ کرم آج ${getEarliestTime()} کے بعد کا کوئی وقت منتخب کریں. کم از کم تیاری کا وقت ${MIN_PICKUP_TIME_MINUTES} منٹ ہے۔`, "غلطی");
        return;
    }

    try {
        document.getElementById('submit-order-btn').disabled = true;
        document.getElementById('submit-order-btn').textContent = "آرڈر بھیجا جا رہا ہے...";

        const orderData = {
            userId: userId,
            customerName: 'Guest User',
            items: cart.map(item => ({
                id: item.id,
                name: item.name,
                price: item.price,
                quantity: item.quantity
            })),
            totalAmount: cart.reduce((total, item) => total + item.price * item.quantity, 0),
            pickupTime: pickupTime,
            orderTime: new Date().toISOString(),
            status: 'Pending',
        };

        const docRef = await addDoc(collection(db, ORDERS_COLLECTION_PATH), orderData);
        
        showModal(`آپ کا آرڈر (ID: ${docRef.id.substring(0, 8)}) بھیج دیا گیا ہے۔ آپ کا پک اپ ٹائم ${pickupTime} ہے۔ براہ کرم اس صفحہ کو کھُلا رکھیں تاکہ آپ کو ایڈمن کا جواب فوراً مل سکے۔`, "آرڈر بھیجا گیا");
        
        cart = []; // Clear cart after successful submission
        saveCart();
        
    } catch (e) {
        console.error("Error submitting order:", e);
        showModal("آرڈر بھیجنے میں ایک مسئلہ پیش آیا۔ براہ کرم دوبارہ کوشش کریں.", "غلطی");
    } finally {
        document.getElementById('submit-order-btn').disabled = false;
        document.getElementById('submit-order-btn').textContent = "آرڈر بھیجیں";
    }
}

// --- Admin Functions ---

/**
 * Handles the admin PIN login attempt.
 */
window.handleAdminLogin = async function() {
    const pin = await showModal("ایڈمن پینل میں داخل ہونے کے لیے اپنا پن کوڈ درج کریں:", "ایڈمن لاگ ان", true, true);
    
    if (pin === null || pin === false) {
        // Cancelled
        return;
    }

    if (pin === ADMIN_PIN) {
        isAdmin = true;
        showModal("ایڈمن پینل میں خوش آمدید!", "کامیابی").then(() => renderApp());
    } else {
        showModal("غلط پن کوڈ۔", "غلطی");
    }
}

/**
 * Logs out of the admin panel (resets view to customer).
 */
window.handleAdminLogout = function() {
    isAdmin = false;
    showModal("ایڈمن پینل سے لاگ آؤٹ کر دیا گیا ہے۔", "لاگ آؤٹ").then(() => renderApp());
}

/**
 * Saves or updates a product in Firestore.
 */
window.handleProductSubmit = async function(event) {
    event.preventDefault();
    
    const productId = document.getElementById('product-id').value;
    const name = document.getElementById('product-name').value;
    const price = parseFloat(document.getElementById('product-price').value);
    const description = document.getElementById('product-description').value;
    const imageUrl = document.getElementById('product-image-url').value || `https://placehold.co/400x300/e53e3e/fff?text=${name.replace(/\s/g, '+')}`;

    if (!name || isNaN(price) || price <= 0) {
        showModal("براہ کرم درست نام اور قیمت درج کریں۔", "ضروری");
        return;
    }

    const docId = productId || Date.now().toString(); // Use timestamp for new product ID

    try {
        await setDoc(doc(db, PRODUCTS_COLLECTION_PATH, docId), {
            id: docId,
            name,
            price,
            description,
            imageUrl,
            createdAt: new Date().toISOString()
        });
        
        // Reset form after saving
        document.getElementById('product-form').reset();
        document.getElementById('product-id').value = '';
        document.getElementById('save-product-btn').textContent = 'محفوظ کریں';

        showModal(`پروڈکٹ: ${name} کامیابی سے محفوظ ہو گئی ہے۔`, "کامیابی");
    } catch (e) {
        console.error("Error saving product:", e);
        showModal("پروڈکٹ محفوظ کرنے میں غلطی ہوئی.", "غلطی");
    }
}

/**
 * Pre-fills the admin form for editing an existing product.
 * @param {string} productId 
 */
window.editProduct = function(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    document.getElementById('product-id').value = product.id;
    document.getElementById('product-name').value = product.name;
    document.getElementById('product-price').value = product.price;
    document.getElementById('product-description').value = product.description;
    document.getElementById('product-image-url').value = product.imageUrl;
    document.getElementById('save-product-btn').textContent = 'ترمیم محفوظ کریں';

    // Scroll to form
    document.querySelector('.product-form-card').scrollIntoView({ behavior: 'smooth' });
}

/**
 * Deletes a product from Firestore.
 * @param {string} productId 
 * @param {string} productName 
 */
window.deleteProduct = async function(productId, productName) {
    const confirmed = await showModal(`کیا آپ واقعی ${productName} کو حذف کرنا چاہتے ہیں؟`, "تصدیق کریں", true);
    if (confirmed) {
        try {
            await deleteDoc(doc(db, PRODUCTS_COLLECTION_PATH, productId));
            showModal(`${productName} حذف کر دیا گیا ہے۔`, "کامیابی");
        } catch (e) {
            console.error("Error deleting product:", e);
            showModal("پروڈکٹ حذف کرنے میں غلطی ہوئی.", "غلطی");
        }
    }
}

/**
 * Updates the status of an order in Firestore.
 * @param {string} orderId 
 * @param {string} status - 'Accepted', 'Rejected', or 'Completed'
 */
window.updateOrderStatus = async function(orderId, status) {
    try {
        await setDoc(doc(db, ORDERS_COLLECTION_PATH, orderId), { status }, { merge: true });
        showModal(`آرڈر ${orderId.substring(0, 8)} کا اسٹیٹس "${status}" میں تبدیل کر دیا گیا ہے۔`, "کامیابی");
    } catch (e) {
        console.error("Error updating order status:", e);
        showModal("آرڈر کا اسٹیٹس اپ ڈیٹ کرنے میں غلطی ہوئی.", "غلطی");
    }
}

// --- Rendering Logic (DOM Manipulation) ---

function renderProductGrid() {
    const grid = document.getElementById('product-grid');
    grid.innerHTML = products.map(p => `
        <div class="product-card">
            <img src="${p.imageUrl}" alt="${p.name}" onerror="this.onerror=null; this.src='https://placehold.co/300x200/e53e3e/fff?text=No+Image';">
            <div class="product-info">
                <h3>${p.name}</h3>
                <p>${p.description}</p>
                <p class="product-price">${formatPrice(p.price)}</p>
            </div>
            <button class="add-to-cart-btn" onclick="addToCart('${p.id}')">
                ٹوکری میں شامل کریں
            </button>
        </div>
    `).join('');

    if (products.length === 0) {
        grid.innerHTML = '<p style="text-align: center; padding: 50px; grid-column: 1 / -1; color: #777;">معاف کیجئے، فی الحال کوئی پروڈکٹ موجود نہیں ہے۔</p>';
    }
}

function renderCart() {
    const cartItemsDiv = document.getElementById('cart-items');
    const cartTotalSpan = document.getElementById('cart-total');
    const submitBtn = document.getElementById('submit-order-btn');
    const pickupTimeInput = document.getElementById('pickup-time-input');
    const orderStatusMessage = document.getElementById('order-status-message');

    // Cart Items
    if (cart.length === 0) {
        cartItemsDiv.innerHTML = '<p class="empty-cart-message">آپ کی ٹوکری خالی ہے۔</p>';
    } else {
        cartItemsDiv.innerHTML = cart.map(item => `
            <div class="cart-item">
                <div class="cart-item-details">
                    <strong>${item.name}</strong>
                    <span>${formatPrice(item.price)}</span>
                </div>
                <div class="quantity-controls">
                    <button onclick="updateCartQuantity('${item.id}', 1)">+</button>
                    <span>${item.quantity}</span>
                    <button onclick="updateCartQuantity('${item.id}', -1)">-</button>
                </div>
            </div>
        `).join('');
    }

    // Cart Total
    const cartTotal = cart.reduce((total, item) => total + item.price * item.quantity, 0);
    cartTotalSpan.textContent = formatPrice(cartTotal);
    
    // Check for customer's pending/accepted order status
    const customerOrder = orders.find(o => o.userId === userId && (o.status === 'Pending' || o.status === 'Accepted'));
    
    // Pickup Time (Set minimum time and handle input constraints)
    const earliestTime = getEarliestTime();
    pickupTimeInput.min = earliestTime;
    if (!pickupTimeInput.value) {
        pickupTimeInput.value = earliestTime;
    }

    // Order Submission/Status Logic
    if (customerOrder) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'آپ کا آرڈر زیر کار ہے';
        orderStatusMessage.classList.remove('hidden');
        
        let statusClass = customerOrder.status === 'Accepted' ? 'status-accepted' : 'status-pending';
        let statusText = customerOrder.status === 'Accepted' 
            ? `قبول کر لیا گیا! پک اپ: ${customerOrder.pickupTime}` 
            : `زیر التوا... پک اپ: ${customerOrder.pickupTime}`;
            
        orderStatusMessage.className = `status-message ${statusClass}`;
        orderStatusMessage.textContent = statusText;

    } else {
        submitBtn.disabled = cart.length === 0;
        submitBtn.textContent = 'آرڈر بھیجیں';
        orderStatusMessage.classList.add('hidden');
    }
}

function renderAdminProductList() {
    const list = document.getElementById('product-list-admin');
    list.innerHTML = products.map(p => `
        <div class="admin-product-item">
            <span>${p.name} (${formatPrice(p.price)})</span>
            <div class="admin-actions">
                <button class="edit-btn" onclick="editProduct('${p.id}')">ترمیم</button>
                <button class="delete-btn" onclick="deleteProduct('${p.id}', '${p.name}')">حذف</button>
            </div>
        </div>
    `).join('');
}

function renderAdminOrders() {
    const list = document.getElementById('orders-list');
    list.innerHTML = orders.map(o => {
        const orderStatusMap = {
            'Pending': 'زیر التوا',
            'Accepted': 'قبول شدہ',
            'Rejected': 'مسترد',
            'Completed': 'مکمل'
        };
        
        let actionButtons = '';
        if (o.status === 'Pending') {
            actionButtons = `
                <button class="action-accept" onclick="updateOrderStatus('${o.id}', 'Accepted')">قبول کریں</button>
                <button class="action-reject" onclick="updateOrderStatus('${o.id}', 'Rejected')">مسترد کریں</button>
            `;
        } else if (o.status === 'Accepted') {
            actionButtons = `
                <button class="action-complete" onclick="updateOrderStatus('${o.id}', 'Completed')">تیار/مکمل کریں</button>
            `;
        }
        
        return `
            <div class="order-item status-${o.status}">
                <div class="order-header">
                    <strong>آرڈر ID: ${o.id.substring(0, 8)}</strong>
                    <span class="order-status">${orderStatusMap[o.status]}</span>
                </div>
                <p>پک اپ ٹائم: <strong>${o.pickupTime}</strong></p>
                <p>کل رقم: <strong>${formatPrice(o.totalAmount)}</strong></p>
                <p>یوزر ID: <span style="font-size: 10px;">${o.userId}</span></p>
                
                <ul style="list-style: inside disc; margin-top: 10px; font-size: 0.9rem;">
                    ${o.items.map(item => `<li>${item.quantity}x ${item.name} (${formatPrice(item.price)})</li>`).join('')}
                </ul>
                
                <div class="order-actions" style="margin-top: 15px;">
                    ${actionButtons}
                </div>
            </div>
        `;
    }).join('');

    if (orders.length === 0) {
        list.innerHTML = '<p style="text-align: center; padding: 20px; color: #777;">کوئی آرڈر موصول نہیں ہوا۔</p>';
    }
}


function renderApp() {
    const customerView = document.getElementById('customer-view');
    const adminView = document.getElementById('admin-view');
    const adminLoginBtn = document.getElementById('admin-login-btn');
    const adminLogoutBtn = document.getElementById('admin-logout-btn');

    if (isAdmin) {
        customerView.classList.add('hidden');
        adminView.classList.remove('hidden');
        adminLoginBtn.classList.add('hidden');
        adminLogoutBtn.classList.remove('hidden');
        
        renderAdminProductList();
        renderAdminOrders();
    } else {
        customerView.classList.remove('hidden');
        adminView.classList.add('hidden');
        adminLoginBtn.classList.remove('hidden');
        adminLogoutBtn.classList.add('hidden');
        
        renderProductGrid();
        renderCart();
    }
}

// --- Event Listeners and Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    // Attach main buttons to functions
    document.getElementById('admin-login-btn').addEventListener('click', window.handleAdminLogin);
    document.getElementById('admin-logout-btn').addEventListener('click', window.handleAdminLogout);
    document.getElementById('submit-order-btn').addEventListener('click', window.submitOrder);
    document.getElementById('product-form').addEventListener('submit', window.handleProductSubmit);
    
    // Initialize Firebase
    initFirebase();
});

// Export functions to global scope so they can be called from inline HTML (like onclick)
window.editProduct = window.editProduct;
window.deleteProduct = window.deleteProduct;
window.updateOrderStatus = window.updateOrderStatus;
window.addToCart = window.addToCart;
window.updateCartQuantity = window.updateCartQuantity;

