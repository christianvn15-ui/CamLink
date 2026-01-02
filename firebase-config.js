<!-- Add this in your index.html before app.js -->
<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-database-compat.js"></script>
<script>
  const firebaseConfig = {
    apiKey: "AIzaSyCgvYATbFF3aOwIB0-ddWHEhvQwWnhyJ2U",
    authDomain: "camlink-c57a6.firebaseapp.com",
    databaseURL: "https://camlink-c57a6-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "camlink-c57a6",
    storageBucket: "camlink-c57a6.appspot.com",
    messagingSenderId: "47975714680",
    appId: "1:47975714680:web:ac2fff20b75ef783a4028d"
  };

  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();

  window.FirebaseRTDB = {
    getDatabase: () => db,
    ref: (dbOrPath, pathMaybe) => {
      if (typeof dbOrPath === 'string') return db.ref(dbOrPath);
      return db.ref(pathMaybe);
    },
    set: (ref, value) => ref.set(value),
    push: (ref, value) => ref.push(value),
    remove: (ref) => ref.remove(),
    onValue: (ref, cb) => ref.on('value', cb),
    onChildAdded: (ref, cb) => ref.on('child_added', cb)
  };
</script>