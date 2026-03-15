const express = require('express');
const router = express.Router();
const plex = require('../plex');

// GET /api/movies?search=&genre=&sort=title
router.get('/', async (req, res) => {
  try {
    const sections = await plex.getMovieSections();
    if (!sections.length) return res.json({ movies: [], genres: [] });

    const { search = '', genre = '', sort = 'title' } = req.query;

    const allMovies = [];
    for (const section of sections) {
      const { movies } = await plex.getMovies(section.key);
      allMovies.push(...movies);
    }

    // Collect all unique genres across the library
    const genreSet = new Set();
    allMovies.forEach(m => {
      (m.Genre || []).forEach(g => genreSet.add(g.tag));
    });
    const genres = [...genreSet].sort();

    let filtered = allMovies;

    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(m => m.title.toLowerCase().includes(q));
    }

    if (genre) {
      filtered = filtered.filter(m =>
        (m.Genre || []).some(g => g.tag === genre)
      );
    }

    // Sort
    if (sort === 'year') {
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (sort === 'rating') {
      filtered.sort((a, b) =>
        (b.audienceRating || b.rating || 0) - (a.audienceRating || a.rating || 0)
      );
    } else {
      // Default: title
      filtered.sort((a, b) => a.title.localeCompare(b.title));
    }

    const mapped = filtered.map(m => ({
      ratingKey: m.ratingKey,
      title: m.title,
      year: m.year,
      summary: m.summary,
      duration: m.duration,
      thumb: m.thumb ? `/api/stream/thumb/${m.ratingKey}` : null,
      rating: m.audienceRating || m.rating || null,
      genres: (m.Genre || []).map(g => g.tag)
    }));

    res.json({ movies: mapped, genres });
  } catch (err) {
    console.error('Movies error:', err.message);
    res.status(500).json({ error: 'Failed to fetch movies' });
  }
});

// GET /api/movies/:ratingKey
router.get('/:ratingKey', async (req, res) => {
  if (!/^\d+$/.test(req.params.ratingKey)) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }
  try {
    const movie = await plex.getMovieDetails(req.params.ratingKey);
    const part = movie.Media?.[0]?.Part?.[0];

    res.json({
      ratingKey: movie.ratingKey,
      title: movie.title,
      year: movie.year,
      summary: movie.summary,
      duration: movie.duration,
      partId: part?.id ?? null,
      thumb: movie.thumb ? `/api/stream/thumb/${movie.ratingKey}` : null
    });
  } catch (err) {
    console.error('Movie detail error:', err.message);
    res.status(500).json({ error: 'Failed to fetch movie' });
  }
});

module.exports = router;
