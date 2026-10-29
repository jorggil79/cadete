// Configuración de Cadete B.
// 1) firebaseConfig: cópiala de la consola de Firebase
//    (Configuración del proyecto → General → Tus apps → app web → «Configuración del SDK» → Config).
//    Estos datos no son secretos: lo que protege la información son las reglas de Firestore.
export const firebaseConfig = {
  apiKey: "AIzaSyCcOp_ZQ9-rQ0HP42JTzjRQExorMTCYCMM",
  authDomain: "cadete-50a5b.firebaseapp.com",
  projectId: "cadete-50a5b",
  storageBucket: "cadete-50a5b.firebasestorage.app",
  messagingSenderId: "273037955935",
  appId: "1:273037955935:web:730a7ab0529ecd52d5dcea"
};

// 2) ID de usuario del administrador. Regístrate en la app: el ID aparece en la pantalla
//    de «Solicitud pendiente». Pega aquí ese mismo ID y también en las reglas de Firestore.
export const ADMIN_UID = "gA2nTXzSIQdNjA9w8N0jf7GYJ2m2";
